import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src");
const entryFile = path.join(sourceRoot, "main.tsx");
const extensions = [".ts", ".tsx", ".js", ".jsx"];

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => path.join(base, `index${extension}`)),
    base,
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function parse(file) {
  const content = fs.readFileSync(file, "utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
}

function reachableFiles() {
  const visited = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = parse(file);
    source.forEachChild((node) => {
      let specifier = null;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.expression.arguments[0] &&
        ts.isStringLiteral(node.expression.arguments[0])
      ) {
        specifier = node.expression.arguments[0].text;
      }
      const resolved = specifier ? resolveModule(file, specifier) : null;
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    });

    function inspectDynamic(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const resolved = resolveModule(file, node.arguments[0].text);
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      }
      ts.forEachChild(node, inspectDynamic);
    }
    inspectDynamic(source);
  }
  return [...visited];
}

function attributeMap(attributes) {
  return new Map(attributes.properties.filter(ts.isJsxAttribute).map((attribute) => [attribute.name.text, attribute.initializer]));
}

function attributeText(initializer) {
  if (!initializer) return "true";
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression) return initializer.expression.getText();
  return initializer.getText();
}

const files = reachableFiles();
const findings = [];
for (const file of files.filter((candidate) => candidate.endsWith(".tsx"))) {
  const source = parse(file);
  function inspect(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === "button") {
      const attributes = attributeMap(node.attributes);
      const type = attributeText(attributes.get("type"));
      const action = attributes.get("onClick");
      const actionText = attributeText(action);
      const delegatesButtonProps = node.attributes.properties.some(ts.isJsxSpreadAttribute);
      const hasAction =
        attributes.has("onClick") ||
        attributes.has("onPointerDown") ||
        attributes.has("onMouseDown") ||
        attributes.has("formAction") ||
        delegatesButtonProps ||
        type === "submit" ||
        type === "reset";
      const emptyAction = actionText === "() => {}" || actionText === "() => undefined";
      if (!hasAction || emptyAction) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          file: path.relative(process.cwd(), file),
          line: position.line + 1,
          reason: emptyAction ? "empty-action" : "missing-action",
          ariaLabel: attributeText(attributes.get("aria-label")),
          title: attributeText(attributes.get("title")),
        });
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}

const result = { reachableFiles: files.length, count: findings.length, findings };
console.log(JSON.stringify(result, null, 2));
if (findings.length > 0) process.exitCode = 1;
