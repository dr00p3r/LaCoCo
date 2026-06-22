import fs from "node:fs";
import path from "node:path";

const source = path.resolve("src/persistence/lacoco-graph-manager/migrations");
const destination = path.resolve("dist/persistence/lacoco-graph-manager/migrations");

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true, force: true });
