import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  const buttonCreateTemplateImplementation = vscode.commands.registerCommand(
    "faftemplate.createTemplateImplementation",
    async (uri: vscode.Uri) => {
      try {
        if (!uri || !uri.fsPath) {
          vscode.window.showErrorMessage("No target folder selected.");
          return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder is open.");
          return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const targetPath = uri.fsPath;

        // Получаем доступные шаблоны для текущей папки
        const availableTemplates = getAvailableTemplatesForPath(
          targetPath,
          rootPath
        );

        if (availableTemplates.length === 0) {
          vscode.window.showWarningMessage(
            "No .templates folder found in parent directories."
          );
          return;
        }

        const allTemplates = availableTemplates.flatMap((dir) =>
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({ name: d.name, fullPath: path.join(dir, d.name) }))
        );

        const templateLookup = new Map<string, string>();
        allTemplates.forEach((t) => templateLookup.set(t.name, t.fullPath));

        const visibleTemplates = allTemplates.filter(
          (t) => !t.name.startsWith(".") && !/^\(.*\)$/.test(t.name)
        );

        if (visibleTemplates.length === 0) {
          vscode.window.showWarningMessage("No visible templates found.");
          return;
        }

        const selected = await vscode.window.showQuickPick(
          visibleTemplates.map((t) => t.name),
          { placeHolder: "Select a template to copy" }
        );
        if (!selected) {
          return;
        }

        const templateFull = templateLookup.get(selected);
        if (!templateFull) {
          vscode.window.showErrorMessage("Selected template not found.");
          return;
        }

        const allVarsSet = findAllTemplateVars(
          templateFull,
          availableTemplates,
          templateLookup
        );
        const allVars = Array.from(allVarsSet);
        if (allVars.length === 0) {
          vscode.window.showWarningMessage("No template variables found.");
        }

        // Группируем переменные по базовому имени (без "case" и стиля)
        const groups = new Map<string, Set<string>>();
        for (const ph of allVars) {
          const inner = ph.replace(/^__|__$/g, "");
          // Убираем "case" в конце и все специальные символы для нормализации
          const normalized = inner
            .replace(/[Cc][Aa][Ss][Ee]$/i, "")
            .replace(/[^A-Za-z0-9]/g, "")
            .toLowerCase();
          const s = groups.get(normalized) ?? new Set<string>();
          s.add(ph);
          groups.set(normalized, s);
        }

        const uniqueNormalized = Array.from(groups.keys());
        const formValues: Record<string, string> = {};
        for (const norm of uniqueNormalized) {
          const defaultVal = path.basename(targetPath);
          const value = await vscode.window.showInputBox({
            prompt: `Enter value for ${norm}`,
            value: defaultVal,
          });
          if (value === undefined) {
            vscode.window.showWarningMessage("Template creation cancelled.");
            return;
          }
          formValues[norm] = value;
        }

        const vars: Record<string, string> = {};
        for (const [normalized, placeholders] of groups.entries()) {
          const userValue = formValues[normalized];
          const variants = buildSmartNameVariants(userValue);
          for (const ph of placeholders) {
            const inner = ph.replace(/^__|__$/g, "");
            const variantKey = detectPlaceholderVariant(inner);
            const replacement = (variants as any)[variantKey] ?? variants.lower;
            vars[ph] = replacement;
          }
        }

        await copyTemplateWithFileIncludes(
          templateFull,
          targetPath,
          vars,
          availableTemplates,
          templateLookup
        );
        vscode.window.showInformationMessage(
          `Template "${selected}" copied to ${targetPath}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error: ${err.message}`);
      }
    }
  );
  context.subscriptions.push(buttonCreateTemplateImplementation);
}

function getAvailableTemplatesForPath(
  targetPath: string,
  rootPath: string
): string[] {
  const available: string[] = [];
  let currentPath = path.normalize(targetPath);
  const normalizedRoot = path.normalize(rootPath);

  // Идем вверх по иерархии от targetPath до rootPath
  while (currentPath.startsWith(normalizedRoot)) {
    const parentDir = path.dirname(currentPath);

    // Проверяем, есть ли .templates в родительской директории
    const templatesPath = path.join(parentDir, ".templates");
    if (
      fs.existsSync(templatesPath) &&
      fs.statSync(templatesPath).isDirectory()
    ) {
      if (!available.includes(templatesPath)) {
        available.push(templatesPath);
      }
    }

    // Проверяем конфигурацию для дополнительных путей шаблонов
    const config = vscode.workspace.getConfiguration("testplugin");
    const configuredPaths: string[] = config.get("templatePaths") || [];
    for (const relPath of configuredPaths) {
      const absPath = path.resolve(rootPath, relPath);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
        // Проверяем, что этот путь находится в иерархии от currentPath
        const templateParent = path.dirname(absPath);
        if (
          currentPath.startsWith(templateParent) &&
          !available.includes(absPath)
        ) {
          available.push(absPath);
        }
      }
    }

    // Если достигли корня, прекращаем
    if (parentDir === currentPath) {
      break;
    }
    currentPath = parentDir;
  }

  return available;
}

function findTemplatePath(
  relPath: string,
  templateRoots: string[],
  templateLookup?: Map<string, string>
): string | null {
  if (
    path.isAbsolute(relPath) &&
    fs.existsSync(relPath) &&
    fs.statSync(relPath).isDirectory()
  ) {
    return relPath;
  }
  const parts = relPath.split("/").filter(Boolean);

  if (parts.length > 0 && templateLookup) {
    if (templateLookup.has(parts[0])) {
      const base = templateLookup.get(parts[0])!;
      if (parts.length === 1) {
        return base;
      }
      const rest = parts.slice(1).join(path.sep);
      const candidate = path.join(base, rest);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      return base;
    }
  }

  for (const root of templateRoots) {
    const abs = path.join(root, relPath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return abs;
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const d of entries) {
        if (d.isDirectory() && d.name === parts[0]) {
          const base = path.join(root, d.name);
          if (parts.length === 1) {
            return base;
          }
          const rest = parts.slice(1).join(path.sep);
          const candidate = path.join(base, rest);
          if (
            fs.existsSync(candidate) &&
            fs.statSync(candidate).isDirectory()
          ) {
            return candidate;
          }
          return base;
        }
      }
    } catch {}
  }
  return null;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function splitToWords(input: string): string[] {
  if (!input) {
    return [];
  }
  let s = String(input);
  s = s.replace(/[\s._-]+/g, " ");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  s = s.replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2");
  s = s.trim();
  return s ? s.split(/\s+/).map((w) => w.toLowerCase()) : [];
}

function buildSmartNameVariants(input: string): {
  lower: string;
  pascal: string;
  upper: string;
  snake: string;
  kebab: string;
  camel: string;
} {
  const words = splitToWords(input);
  const lower = words.join("");
  const upper = lower.toUpperCase();
  const pascal = words.map(capitalize).join("");
  const snake = words.join("_");
  const kebab = words.join("-");
  const camel =
    words.length > 0 ? words[0] + words.slice(1).map(capitalize).join("") : "";
  return { lower, pascal, upper, snake, kebab, camel };
}

function detectPlaceholderVariant(
  inner: string
): "lower" | "pascal" | "upper" | "snake" | "kebab" | "camel" {
  // Сначала простые детекторы по разделителям
  if (inner.includes("-")) return "kebab";
  if (inner.includes("_")) return "snake";

  // Если вся строка в верхнем регистре и заканчивается на 'CASE' — UPPER
  if (inner === inner.toUpperCase() && inner.toUpperCase().endsWith("CASE")) {
    return "upper";
  }

  // Если строка заканчивается на 'Case' (с заглавной C) — различаем Pascal/Camel
  if (inner.endsWith("Case")) {
    const first = inner.charAt(0);
    // Начинается с заглавной — Pascal (NameCase)
    if (first === first.toUpperCase()) return "pascal";
    // Иначе — camel (nameCase)
    return "camel";
  }

  // Если вся строка в нижнем регистре и заканчивается на 'case' — lower
  if (inner === inner.toLowerCase() && inner.toLowerCase().endsWith("case")) {
    return "lower";
  }

  // Фоллбэки: если где-то есть заглавные буквы — camel/pascal
  if (/[A-Z]/.test(inner)) {
    return /^[A-Z]/.test(inner) ? "pascal" : "camel";
  }

  // По умолчанию — lower
  return "lower";
}

function replaceVars(str: string, vars: Record<string, string>): string {
  let result = str;

  // Сортируем по длине ключа (от большего к меньшему)
  const entries = Object.entries(vars).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [key, value] of entries) {
    // Создаем regex, который НЕ захватывает дополнительные подчеркивания
    // Используем negative lookbehind и lookahead для подчеркиваний
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex = new RegExp(escapedKey, "g");
    result = result.replace(regex, value);
  }

  return result;
}

function findAllTemplateVars(
  dir: string,
  templateRoots: string[],
  templateLookup: Map<string, string>,
  found = new Set<string>(),
  visited = new Set<string>()
): Set<string> {
  if (!fs.existsSync(dir) || visited.has(dir)) {
    return found;
  }
  visited.add(dir);

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    const includeMatch = entry.name.match(/^__INCLUDE__\(([^)]+)\)$/);
    if (includeMatch) {
      const includeRel = includeMatch[1];
      const includeFull = findTemplatePath(
        includeRel,
        templateRoots,
        templateLookup
      );
      if (includeFull) {
        findAllTemplateVars(
          includeFull,
          templateRoots,
          templateLookup,
          found,
          visited
        );
      }
      continue;
    }

    // Ищем только переменные, которые заканчиваются на "case" (регистронезависимо)
    const nameMatches = entry.name.match(
      /__([A-Za-z0-9][A-Za-z0-9_-]*[Cc][Aa][Ss][Ee])__/g
    );
    if (nameMatches) {
      nameMatches.forEach((m) => found.add(m));
    }

    if (entry.isDirectory()) {
      findAllTemplateVars(
        entryPath,
        templateRoots,
        templateLookup,
        found,
        visited
      );
    } else {
      try {
        const content = fs.readFileSync(entryPath, "utf8");
        const contentMatches = content.match(
          /__([A-Za-z0-9][A-Za-z0-9_-]*[Cc][Aa][Ss][Ee])__/g
        );
        if (contentMatches) {
          contentMatches.forEach((m) => found.add(m));
        }
      } catch {}
    }
  }
  return found;
}

async function copyTemplateWithFileIncludes(
  src: string,
  dest: string,
  vars: Record<string, string>,
  templateRoots: string[],
  templateLookup?: Map<string, string>
): Promise<void> {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const includeMatch = entry.name.match(/^__INCLUDE__\(([^)]+)\)$/);
    if (includeMatch) {
      let includeRel = replaceVars(includeMatch[1], vars);
      const includeFull = findTemplatePath(
        includeRel,
        templateRoots,
        templateLookup
      );
      if (!includeFull) {
        vscode.window.showWarningMessage(
          `Include "${includeRel}" not found. Skipping...`
        );
        continue;
      }

      const nestedVars = { ...vars };

      await copyTemplateWithFileIncludes(
        includeFull,
        dest,
        nestedVars,
        templateRoots,
        templateLookup
      );
      continue;
    }
    const replacedName = replaceVars(entry.name, vars);
    const destPath = path.join(dest, replacedName);
    if (entry.isDirectory()) {
      await copyTemplateWithFileIncludes(
        srcPath,
        destPath,
        vars,
        templateRoots,
        templateLookup
      );
    } else {
      try {
        let content = fs.readFileSync(srcPath, "utf8");
        content = replaceVars(content, vars);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content, "utf8");
      } catch {
        const buf = fs.readFileSync(srcPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, buf);
      }
    }
  }
}
