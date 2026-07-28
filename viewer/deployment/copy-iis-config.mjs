import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(currentDirectory, "../../deployment/iis/web.config");
const destination = resolve(currentDirectory, "../dist/web.config");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Copied IIS configuration to ${destination}`);
