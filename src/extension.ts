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
        const config = vscode.workspace.getConfiguration("testplugin");
        const templatePaths: string[] = config.get("templatePaths") || [];

        const defaultPath = path.join(rootPath, ".templates");
        if (fs.existsSync(defaultPath)) templatePaths.push(defaultPath);

        const templates: string[] = [];
        for (const rel of templatePaths) {
          const abs = path.resolve(rootPath, rel);
          if (fs.existsSync(abs)) templates.push(abs);
        }

        const targetPath = uri.fsPath;

        // Collect all templates
        const allTemplates = templates.flatMap((dir) =>
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .map((d) => ({
              name: d.name,
              fullPath: path.join(dir, d.name),
            }))
        );

        // Separate visible and hidden (names in parentheses) templates
        const visibleTemplates = allTemplates.filter(
          (t) => !/^\(.*\)$/.test(t.name)
        );
        const hiddenTemplates = allTemplates.filter((t) =>
          /^\(.*\)$/.test(t.name)
        );

        const selected = await vscode.window.showQuickPick(
          visibleTemplates.map((t) => t.name),
          { placeHolder: "Select a template to copy" }
        );
        if (!selected) return;

        const template = allTemplates.find((t) => t.name === selected)!;

        // Find all placeholders in the template (recursively in file names and content)
        const allVarsSet = findTemplateVars(template.fullPath);
        const allVars = Array.from(allVarsSet);
        if (allVars.length === 0) {
          vscode.window.showWarningMessage("No template variables found.");
        }

        // Group placeholders by normalized name:
        // e.g. "__name__", "__naMe__", "__na_me__" -> normalized "name"
        const groups = new Map<string, Set<string>>();
        for (const ph of allVars) {
          const inner = ph.replace(/^__|__$/g, "");
          const normalized = inner.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
          const s = groups.get(normalized) ?? new Set<string>();
          s.add(ph);
          groups.set(normalized, s);
        }

        const uniqueNormalized = Array.from(groups.keys());

        // Request a single value for each logical variable (normalized name)
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

        // Build concrete replacements for all observed placeholders
        const vars: Record<string, string> = {};

        for (const [normalized, placeholders] of groups.entries()) {
          const userValue = formValues[normalized];
          const variants = buildSmartNameVariants(userValue);

          for (const ph of placeholders) {
            const inner = ph.replace(/^__|__$/g, "");
            const variantKey = detectPlaceholderVariant(inner);
            let replacement = (variants as any)[variantKey];
            if (replacement === undefined) {
              replacement = variants.lower;
            }
            vars[ph] = replacement;
          }
        }

        // Copy template with replacements
        copyTemplateWithFileIncludes(
          template.fullPath,
          targetPath,
          vars,
          templates.concat(hiddenTemplates.map((t) => t.fullPath))
        );

        vscode.window.showInformationMessage(
          `Template "${selected}" copied to ${targetPath}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error: ${err.message}`);
      }
    }
  );

  // Register the command in subscriptions
  // (this only affects disposal; menu placement is controlled in package.json)
  context.subscriptions.push(buttonCreateTemplateImplementation);
}

/**
 * Recursive copy of a template folder, supports __INCLUDE__(path)
 */
function copyTemplateWithFileIncludes(
  src: string,
  dest: string,
  vars: Record<string, string>,
  templateRoots: string[]
) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);

    // If this directory is an include directive __INCLUDE__(path)
    const includeMatch = entry.name.match(/^__INCLUDE__\(([\w\/().-]+)\)$/);
    if (includeMatch) {
      const includeRel = includeMatch[1];
      const includeFull = findTemplatePath(includeRel, templateRoots);
      if (!includeFull) {
        vscode.window.showWarningMessage(`Include "${includeRel}" not found.`);
        continue;
      }

      // Copy contents of the include folder directly into the destination
      for (const incEntry of fs.readdirSync(includeFull, {
        withFileTypes: true,
      })) {
        const incSrc = path.join(includeFull, incEntry.name);
        const incDest = path.join(dest, replaceVars(incEntry.name, vars));

        if (incEntry.isDirectory()) {
          copyTemplateWithFileIncludes(incSrc, incDest, vars, templateRoots);
        } else {
          let content = fs.readFileSync(incSrc, "utf8");
          content = replaceVars(content, vars);
          fs.writeFileSync(incDest, content, "utf8");
        }
      }
      continue;
    }

    // Regular handling of files and folders
    const replacedName = replaceVars(entry.name, vars);
    const destPath = path.join(dest, replacedName);

    if (entry.isDirectory()) {
      copyTemplateWithFileIncludes(srcPath, destPath, vars, templateRoots);
    } else {
      let content = fs.readFileSync(srcPath, "utf8");
      content = replaceVars(content, vars);
      fs.writeFileSync(destPath, content, "utf8");
    }
  }
}

/**
 * Find a template folder path inside provided roots.
 */
function findTemplatePath(
  relPath: string,
  templateRoots: string[]
): string | null {
  for (const root of templateRoots) {
    const abs = path.join(root, relPath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return abs;
    }
  }
  return null;
}

/**
 * Safe replace implementation: escape regex meta characters in keys.
 */
function replaceVars(str: string, vars: Record<string, string>): string {
  let result = str;
  for (const [key, value] of Object.entries(vars)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedKey, "g");
    result = result.replace(regex, value);
  }
  return result;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Build different-case variants from the user input:
 * lower (printline), pascal (PrintLine), upper (PRINTLINE),
 * snake (print_line), kebab (print-line), camel (printLine)
 */
function buildSmartNameVariants(input: string): {
  lower: string;
  pascal: string;
  upper: string;
  snake: string;
  kebab: string;
  camel: string;
} {
  const base = input
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();

  const words = base ? base.split(/\s+/) : [];

  const lower = words.join("");
  const upper = lower.toUpperCase();
  const pascal = words.map(capitalize).join("");
  const snake = words.join("_");
  const kebab = words.join("-");
  const camel =
    words.length > 0 ? words[0] + words.slice(1).map(capitalize).join("") : "";

  return {
    lower,
    pascal,
    upper,
    snake,
    kebab,
    camel,
  };
}

/**
 * Detect which variant a placeholder represents.
 * inner is the placeholder without surrounding __, e.g. "naMe", "na_me", "NAME2"
 * Returns one of: 'lower' | 'pascal' | 'upper' | 'snake' | 'kebab' | 'camel'
 */
function detectPlaceholderVariant(
  inner: string
): "lower" | "pascal" | "upper" | "snake" | "kebab" | "camel" {
  if (inner.includes("-")) return "kebab";
  if (inner.includes("_")) return "snake";
  if (/^[A-Z0-9_]+$/.test(inner)) return "upper";
  if (/^[a-z0-9]+$/.test(inner)) return "lower";
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(inner)) return "camel";
  return "pascal";
}

/**
 * Recursively find placeholders of the form __...__ in a directory.
 * Returns a Set of strings like "__naMe__".
 */
function findTemplateVars(dir: string, found = new Set<string>()): Set<string> {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    // Search in file/folder name
    const nameMatches = entry.name.match(/__([A-Za-z0-9_-]+)__/g);
    if (nameMatches) {
      nameMatches.forEach((m) => {
        if (!m.startsWith("__INCLUDE__")) found.add(m);
      });
    }

    if (entry.isDirectory()) {
      findTemplateVars(entryPath, found);
    } else {
      // Search inside file content
      try {
        const content = fs.readFileSync(entryPath, "utf8");
        const contentMatches = content.match(/__([A-Za-z0-9_-]+)__/g);
        if (contentMatches) {
          contentMatches.forEach((m) => {
            if (!m.startsWith("__INCLUDE__")) found.add(m);
          });
        }
      } catch (e) {
        // Binary or unreadable file - skip
      }
    }
  }
  return found;
}
