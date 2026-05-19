import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, join } from "path";

const SRC_DIR = resolve(import.meta.dir, "../src");
const OUT_DIR = resolve(import.meta.dir, "..");

interface RouteEntry {
  method: string;
  path: string;
  line: number;
  endLine: number;
  file: string;
  description?: string;
}

interface FunctionEntry {
  name: string;
  line: number;
  endLine: number;
  file: string;
  params: string;
  exported: boolean;
}

interface InterfaceEntry {
  name: string;
  line: number;
  endLine: number;
  file: string;
  members: string[];
}

interface SectionEntry {
  title: string;
  line: number;
  file: string;
}

interface FileStats {
  path: string;
  lines: number;
  routes: number;
  functions: number;
  interfaces: number;
}

const allRoutes: RouteEntry[] = [];
const allFunctions: FunctionEntry[] = [];
const allInterfaces: InterfaceEntry[] = [];
const allSections: SectionEntry[] = [];
const fileStats: FileStats[] = [];

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "migrations") continue;
      results.push(...findTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function parseFile(filePath: string) {
  const source = readFileSync(filePath, "utf-8");
  const relPath = relative(resolve(import.meta.dir, ".."), filePath);
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");

  let routeCount = 0;
  let funcCount = 0;
  let ifaceCount = 0;

  function getLineNumber(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function getEndLine(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  }

  // Section dividers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("// =====") || line.includes("// -----")) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.startsWith("//")) {
        const title = nextLine.replace(/^\/\/\s*/, "").trim();
        if (title.length > 3 && title.length < 120) {
          allSections.push({ title, line: i + 1, file: relPath });
        }
      }
    }
  }

  function visit(node: ts.Node) {
    // Route handlers
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        const obj = expr.expression;
        const method = expr.name.getText();
        if (
          ts.isIdentifier(obj) &&
          obj.getText() === "app" &&
          ["get", "post", "put", "patch", "delete"].includes(method)
        ) {
          const args = node.arguments;
          if (args.length >= 2 && ts.isStringLiteral(args[0])) {
            const path = args[0].text;
            const line = getLineNumber(node.getStart());
            const endLine = getEndLine(node);
            let description: string | undefined;
            const lineIdx = line - 2;
            if (lineIdx >= 0) {
              const prevLine = lines[lineIdx]?.trim();
              if (prevLine?.startsWith("//")) {
                description = prevLine.replace(/^\/\/\s*/, "");
              }
            }
            allRoutes.push({ method: method.toUpperCase(), path, line, endLine, file: relPath, description });
            routeCount++;
          }
        }
      }
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText();
      const line = getLineNumber(node.getStart());
      const endLine = getEndLine(node);
      const params = node.parameters.map(p => p.getText()).join(", ");
      const exported = (node.modifiers || []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      allFunctions.push({ name, line, endLine, file: relPath, params, exported });
      funcCount++;
    }

    // Arrow/function expressions assigned to const
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            const name = decl.name.getText();
            const line = getLineNumber(node.getStart());
            const endLine = getEndLine(node);
            const params = decl.initializer.parameters?.map(p => p.getText()).join(", ") || "";
            const exported = (node.modifiers || []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            allFunctions.push({ name, line, endLine, file: relPath, params, exported });
            funcCount++;
          }
        }
      }
    }

    // Interfaces
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText();
      const line = getLineNumber(node.getStart());
      const endLine = getEndLine(node);
      const members = node.members.map(m => {
        if (ts.isPropertySignature(m) && m.name) return m.name.getText();
        return "";
      }).filter(Boolean);
      allInterfaces.push({ name, line, endLine, file: relPath, members });
      ifaceCount++;
    }

    // Type aliases
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText();
      const line = getLineNumber(node.getStart());
      const endLine = getEndLine(node);
      allInterfaces.push({ name, line, endLine, file: relPath, members: [] });
      ifaceCount++;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  fileStats.push({
    path: relPath,
    lines: lines.length,
    routes: routeCount,
    functions: funcCount,
    interfaces: ifaceCount,
  });
}

// Parse all TypeScript files
const tsFiles = findTsFiles(SRC_DIR).sort();
for (const f of tsFiles) {
  parseFile(f);
}

// Sort results
allRoutes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
allFunctions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
allInterfaces.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
fileStats.sort((a, b) => b.lines - a.lines);

const totalLines = fileStats.reduce((s, f) => s + f.lines, 0);

// JSON output
const map = {
  srcDir: "src/",
  totalFiles: tsFiles.length,
  totalLines,
  generated: new Date().toISOString(),
  summary: {
    routes: allRoutes.length,
    functions: allFunctions.length,
    interfaces: allInterfaces.length,
    sections: allSections.length,
  },
  files: fileStats,
  sections: allSections,
  routes: allRoutes,
  functions: allFunctions,
  interfaces: allInterfaces,
};

writeFileSync(resolve(OUT_DIR, "ast-map.json"), JSON.stringify(map, null, 2));

// Markdown output
let md = `# Denbook AST Map\n\n`;
md += `**Scope**: Full \`src/\` tree (${tsFiles.length} files, ${totalLines.toLocaleString()} lines)\n`;
md += `**Generated**: ${new Date().toISOString()}\n\n`;
md += `| Type | Count |\n|------|-------|\n`;
md += `| Files | ${tsFiles.length} |\n`;
md += `| Routes | ${allRoutes.length} |\n`;
md += `| Functions | ${allFunctions.length} |\n`;
md += `| Interfaces/Types | ${allInterfaces.length} |\n`;
md += `| Sections | ${allSections.length} |\n\n`;

md += `## Files by Size\n\n`;
md += `| File | Lines | Routes | Functions |\n|------|-------|--------|-----------|\n`;
for (const f of fileStats) {
  md += `| \`${f.path}\` | ${f.lines} | ${f.routes} | ${f.functions} |\n`;
}

md += `\n## Sections\n\n`;
let currentFile = "";
for (const s of allSections) {
  if (s.file !== currentFile) {
    currentFile = s.file;
    md += `\n### ${s.file}\n`;
  }
  md += `- **L${s.line}** — ${s.title}\n`;
}

md += `\n## Routes\n\n`;
md += `| Method | Path | File | Lines | Description |\n|--------|------|------|-------|-------------|\n`;
for (const r of allRoutes) {
  const desc = r.description || "";
  md += `| ${r.method} | \`${r.path}\` | \`${r.file}\` | ${r.line}-${r.endLine} | ${desc} |\n`;
}

md += `\n## Functions\n\n`;
md += `| Name | File | Lines | Size | Exported |\n|------|------|-------|------|----------|\n`;
for (const f of allFunctions) {
  const size = f.endLine - f.line + 1;
  md += `| ${f.name} | \`${f.file}\` | ${f.line}-${f.endLine} | ${size}L | ${f.exported ? "✓" : ""} |\n`;
}

md += `\n## Interfaces & Types\n\n`;
md += `| Name | File | Lines | Members |\n|------|------|-------|---------|\n`;
for (const i of allInterfaces) {
  const members = i.members.length > 0 ? i.members.slice(0, 5).join(", ") + (i.members.length > 5 ? "..." : "") : "-";
  md += `| ${i.name} | \`${i.file}\` | ${i.line}-${i.endLine} | ${members} |\n`;
}

writeFileSync(resolve(OUT_DIR, "ast-map.md"), md);

console.log(`AST map generated (full src/ tree):`);
console.log(`  ${tsFiles.length} files, ${totalLines.toLocaleString()} lines`);
console.log(`  ${allRoutes.length} routes`);
console.log(`  ${allFunctions.length} functions`);
console.log(`  ${allInterfaces.length} interfaces/types`);
console.log(`  ${allSections.length} sections`);
console.log(`  Output: ast-map.json + ast-map.md`);
