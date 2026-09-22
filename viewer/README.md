# React + TypeScript + Vite

## SymetrIQ local project workflow

First start the converter project server in a separate terminal:

```powershell
cd C:\Development\symetriq-converter
npm run server
```

Then start this frontend:

```powershell
cd C:\Development\symetriq-viewer\viewer
npm run dev
```

For the shared Alpha Hub backend (the same one used by the Revit Copilot), run:

```powershell
npm run dev:alpha
```

This keeps the frontend local while proxying `/api` and `/project-files` to the
Alpha backend configured in `.env.alpha`. Normal `npm run dev` continues to use
the local backend at `http://localhost:3101`.

Open `http://localhost:5173`, create a project, upload IFC/LAS/LAZ files and
open the project with the **Scene** button when at least one file is ready.
The project page polls conversion status automatically.

## Resumable large-file transport test (R2B.4)

Development mode adds a separate **Resumable large-file upload** card to the
project page. It deliberately does not replace the existing **Upload and
process** flow yet: R2B.4 finalizes an upload-session artifact, while project
file registration and E57/IFC conversion belong to R2B.5.

The frontend flow is:

1. create an idempotent server upload session;
2. use the returned `chunkSize` with `File.slice()`;
3. upload raw Blob parts with at most two simultaneous requests;
4. re-query `uploadedParts` and `receivedBytes` as authoritative progress;
5. request asynchronous completion and poll until a terminal state.

Transient network and 5xx failures use three bounded retries (0.5, 1.5 and 4
seconds). Deterministic 4xx errors such as `PART_CONFLICT` stop immediately.
No whole-file browser buffer or client-side whole-file hash is created.

Unfinished session metadata is stored under
`symetriq.resumable-uploads.v1` in browser local storage. It contains the
upload/project IDs, filename, size, last-modified timestamp, file kind,
idempotency key and creation time, but never file bytes. After page reload the
user must reselect the original file; filename, size and last-modified time are
checked before the server's immutable-part validation remains authoritative.
Navigation does not cancel the server session. Only the explicit Cancel action
aborts active requests, calls DELETE and removes local metadata.

### Manual test

1. Start the converter backend containing R2B.3.
2. Run `npm run dev` (local backend) or `npm run dev:alpha` (Alpha backend).
3. Open a project and use the development-only resumable upload card.
4. Select a large IFC, E57, LAS or LAZ file and start the test.
5. Confirm progress advances, then shows **Finalizing…** and finally
   **Finalized successfully**.
6. To test resume, interrupt the network or reload the page mid-upload, re-open
   the project, then use **Reselect and resume** with the same file.

Successful completion in this test means only that the byte-identical upload
artifact was finalized. It is not expected to appear in Project files or start
conversion before R2B.5.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
