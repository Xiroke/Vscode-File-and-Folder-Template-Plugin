# faftemplate README

## EN

## RU

Это плагин для автоматизации создание структур из файлов и папок используя шаблоны

Как начать использовать:

- Скачивание исходников (Этот репозиторий)
- В консоли переходите в эту директорию и пишите

  ```
  npm i
  npm install -g @vscode/vsce
  vsce package
  code --install-extension .\(Название файла).vsix
  ```

- Создаёте папку .templates в корне

  `(Вы также можете создать в вложенной папке, но её действие будет ограничено самой папкой, а также надо будет указать путь в "testplugin.templatePaths": ["folder/.templates"])`

- В ней создаете папку, она будет названием структуры (.templates/ui_components)

  `Внимание: При использовании шаблона будет извлечено содержимое самой папки`

- В шаблонах можно указать вводимое название при созданни используя следующие значения:

  `__namecase__` - lower (printline),

  `__NameCase__` pascal (PrintLine),

  `__NAMECASE__` upper (PRINTLINE),

  `__name_case__` snake (print_line),

  `__name-case__` kebab (print-line),

  `__nameCase__` camel (printLine)

- Также можно в компонентах-шаблонах подключать другие компоненты-шаблоны с помощью `__INCLUDE__(название_компонента)`
  если в них упоминается `__name__` то он будет проброшен от родителя

`.templates/widget/ui/__INCLUDE__(ui_components)`

- Если хотите скрыть компонент и сделать только для импорта, то назовите его, указав в начале точку (.ui_components)

- Чтобы использовать, кликаете по дереву файлов слева правой кнопкой и нажимаете
  `Create Template Implementations`

<!-- ## Features

## Requirements

## Extension Settings

## Known Issues

## Release Notes

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

## Working with Markdown

## For more information -->
