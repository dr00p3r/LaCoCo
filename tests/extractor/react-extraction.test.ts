import { ModuleResolutionKind, Project, ScriptTarget, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { CodeExtractor } from "../../src/extractor/code-extractor.js";
import type { EdgeRow, ExtractionCallbacks, NodeRow } from "../../src/extractor/types.js";
import { RELATION_TO_DIM } from "../../src/domain/dimensions.js";

function extract(files: Record<string, string>): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      moduleResolution: ModuleResolutionKind.NodeJs,
      target: ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      allowJs: true,
    },
  });
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);

  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  const callbacks: ExtractionCallbacks = {
    insertNode: (node) => nodes.push(node),
    insertEdge: (sourceId, targetId, relation) => edges.push({ sourceId, targetId, relation }),
  };
  const extractor = new CodeExtractor(callbacks);
  for (const sourceFile of project.getSourceFiles()) extractor.processFile(sourceFile);
  return { nodes, edges };
}

function edge(sourceId: string, targetId: string, relation: EdgeRow["relation"]): EdgeRow {
  return { sourceId, targetId, relation };
}

describe("React-aware extraction", () => {
  const APP = `
    const forwardRef = (fn: any) => fn;
    const withStyles = (s: any) => (c: any) => c;
    const styles = {};

    export const payload = { n: 1 };

    const Button = () => <div>ok</div>;
    const useThing = () => { return 42; };
    const helperValue = () => 1;

    const Child = (props: any) => <div />;
    const Fancy = forwardRef((props: any, ref: any) => <Button />);

    function Panel() {
      return <Child data={payload} />;
    }

    export default withStyles(styles)(Fancy);
  `;

  it("promotes non-exported arrow components and hooks in JSX files", () => {
    const { nodes } = extract({ "/app.tsx": APP });
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/app.tsx#Button", kind: "ARROW_FUNCTION" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/app.tsx#useThing", kind: "ARROW_FUNCTION" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/app.tsx#Child", kind: "ARROW_FUNCTION" }));
  });

  it("does NOT promote trivial non-React locals (no graph flooding)", () => {
    const { nodes } = extract({ "/app.tsx": APP });
    expect(nodes.find((n) => n.id === "/app.tsx#helperValue")).toBeUndefined();
  });

  it("unwraps forwardRef and emits a RENDERS edge to the rendered child", () => {
    const { nodes, edges } = extract({ "/app.tsx": APP });
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/app.tsx#Fancy" }));
    expect(edges).toContainEqual(edge("/app.tsx#Fancy", "/app.tsx#Button", "RENDERS"));
  });

  it("models JSX composition (RENDERS) and prop-passing (CONSUMES_DATA)", () => {
    const { edges } = extract({ "/app.tsx": APP });
    expect(edges).toContainEqual(edge("/app.tsx#Panel", "/app.tsx#Child", "RENDERS"));
    expect(edges).toContainEqual(edge("/app.tsx#Panel", "/app.tsx#payload", "CONSUMES_DATA"));
  });

  it("does NOT emit RENDERS to lowercase host elements", () => {
    const { edges } = extract({ "/app.tsx": APP });
    expect(edges.some((e) => e.relation === "RENDERS" && e.targetId.endsWith("#div"))).toBe(false);
  });

  it("captures default-export HOC wrappers with a reference to the wrapped component", () => {
    const { nodes, edges } = extract({ "/app.tsx": APP });
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/app.tsx#default", kind: "VARIABLE" }));
    expect(edges).toContainEqual(edge("/app.tsx#default", "/app.tsx#Fancy", "REFERENCES"));
  });

  it("leaves backend .ts files untouched (non-exported locals stay unindexed)", () => {
    const { nodes } = extract({
      "/backend.ts": `
        const compute = () => 42;
        export const publicApi = () => 7;
      `,
    });
    expect(nodes.find((n) => n.id === "/backend.ts#compute")).toBeUndefined();
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/backend.ts#publicApi", kind: "ARROW_FUNCTION" }));
  });

  it("bridges a consumer to a default-HOC-exported component across a barrel (mui idiom)", () => {
    const { nodes, edges } = extract({
      "/pkg/Item/Item.js": `
        import React from "react";
        const withStyles = (s) => (c) => c;
        const styles = {};
        class Item extends React.Component { render() { return <li />; } }
        export default withStyles(styles)(Item);
      `,
      "/pkg/Item/index.js": `export { default } from './Item';`,
      "/pkg/Menu/Menu.js": `
        import React from "react";
        import Item from '../Item';
        function Menu(props) { return <Item />; }
        export default Menu;
      `,
    });
    // El nodo estilo-gold (método de clase) existe.
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/pkg/Item/Item.js#Item.render", kind: "METHOD" }));
    // Cadena de composición: consumidor → default HOC → clase interna.
    expect(edges).toContainEqual(edge("/pkg/Menu/Menu.js#Menu", "/pkg/Item/Item.js#default", "RENDERS"));
    expect(edges).toContainEqual(edge("/pkg/Item/Item.js#default", "/pkg/Item/Item.js#Item", "REFERENCES"));
  });

  it("maps the RENDERS relation to the CPG dimension", () => {
    expect(RELATION_TO_DIM.RENDERS).toBe("CPG");
  });
});
