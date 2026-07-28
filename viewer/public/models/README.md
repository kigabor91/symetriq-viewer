# Development models

This folder is the Viewer development-time model source. Its contents are not
committed to Git.

To run the first model-loading flow:

1. Run `npm run convert` in `symetriq-converter`.
2. Copy these files from `symetriq-converter/output` into this folder:
   - `minta_ifc.xkt`
   - `minta_ifc.metadata.json`
   - `minta_ifc.manifest.json`
3. Keep the filenames unchanged.
4. Run `npm run dev` in the `viewer` folder.

The browser fetches geometry at `/models/minta_ifc.xkt` and metadata at
`/models/minta_ifc.metadata.json`. Later, these hard-coded development URLs
will be replaced by a model-package manifest supplied by the backend.
