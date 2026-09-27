# September 2026 research intake

`research-2026.json` covers 20 works checked against publisher, institutional
repository, author and conference records on 27 September 2026. Seven works
receive new catalogue identities; thirteen existing records receive descriptions,
publication notes and source links. Kishimoto's journal text edition is corrected
from `book` to `article`.

The batch includes three published 2025 works relevant to current research. The
Dékány MITWPL article remains forthcoming, with an author-posted manuscript.
Routledge now announces the Knapen et al. chapter's volume for March 2027.
Conference accepted-paper lists establish acceptance only. Ijas's full thesis
remains embargoed until 24 March 2031; its public summary and abstract are
separate documents.

Preview with the project's database environment configured:

```sh
bun --preload ./scripts/sveltekit-env-shim.ts scripts/import/research-2026.ts
```

Add `--apply` to import through the merge ledger. The importer checks the entire
batch before writing, including normalized identifier ownership and the expected
old values of explicit corrections. Other existing scalar values are preserved.
An interrupted or rejected earlier observation requires review before retrying.
Source rights flags are outside this import.

The parallel grammar intake registers citation keys, source roles and available
PDF text layers. PDFs retain their publisher or author provenance; manuscripts,
conference abstracts and thesis extracts retain their document roles.
