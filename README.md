# decmp.dev upload

Uploads an [objdiff](https://github.com/encounter/objdiff) progress report to [decmp.dev](https://decmp.dev), and
comments on pull requests how they change progress.

No secrets: decmp.dev checks the run's GitHub OIDC token, so a report can only be uploaded by a workflow of the
repository it belongs to. The first upload creates the project.

## Usage

```yaml
name: progress
on:
  push:
    branches: [main]
  pull_request:          # comments how each pull request changes progress

jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # lets decmp.dev verify this run belongs to your repo
      pull-requests: write   # lets it comment on pull requests
    steps:
      - uses: actions/checkout@v5

      # ...build your project and run objdiff here, e.g.
      # objdiff-cli report generate -o build/GZ2E01/report.json

      - uses: decmp/upload-action@v1
        with:
          report: build/GZ2E01/report.json
          version: GZ2E01
          name: "The Legend of Zelda: Twilight Princess"  # first upload only
          platform: gc                                   # first upload only
          banner: assets/banner.webp                     # optional, 1024x256
```

Pushes to the default branch upload the report. Pull requests upload nothing: the action compares the pull request's
report with its base commit's (or the latest report when the base wasn't measured) and keeps one comment per version up
to date, with a Before / After / Δ table, the categories that changed and, against the latest report, the functions
that became matched or regressed. The same table goes to the job summary. Several versions (a matrix) get one comment
each.

## Inputs

| Input | Required | Default | |
|---|---|---|---|
| `report` | yes* | | Path to the JSON report from `objdiff-cli report generate -f json` |
| `version` | yes* | | Game version the report measures, e.g. `GZ2E01` or `SLUS_014.36` |
| `name` | | | Game title (first upload, or to rename) |
| `short-name` | | | Shorter title for badges |
| `platform` | | | Console id: `gbc`, `n64`, `ps`, `gba`, `gc`, `ps2`, `xbox`, `nds`, `psp`, `xbox360`, `wii`, `3ds`, `switch`, `win32` |
| `default-version` | | | Version the project page opens on |
| `banner` | | | Header image in the repository (`.webp`, `.png`, `.jpg` or `.avif`, up to 1 MB; 1024x256 looks best) |
| `github-token` | | `${{ github.token }}` | Token that posts the pull request comment |
| `fail-on-regression` | | `false` | On a pull request, fail the step when matched code, data, functions or complete units go down |
| `comments` | | `decmp-comment` | On `workflow_run`, the directory with the comment files forks' runs uploaded |
| `api-url` | | `https://api.decmp.dev` | decmp.dev API |

\* not needed on `workflow_run`.

Outputs: `comment-file` (on a pull request, the comparison to upload when the pull request comes from a fork) and
`regressed` (`'true'` when the pull request loses progress).

## Pull requests from forks

A fork's pull request runs with a read-only token, so it can't comment. Give the step an id and upload its comparison:

```yaml
      - uses: decmp/upload-action@v1
        id: decmp
        with:
          report: build/GZ2E01/report.json
          version: GZ2E01

      - if: ${{ !cancelled() && github.event.pull_request.head.repo.fork }}
        uses: actions/upload-artifact@v4
        with:
          name: decmp-comment-GZ2E01   # one name per version
          path: ${{ steps.decmp.outputs.comment-file }}
```

and post it from a second workflow, which never checks out the pull request's code:

```yaml
name: progress comment
on:
  workflow_run:
    workflows: [progress]
    types: [completed]

jobs:
  comment:
    if: github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      actions: read          # to download the run's artifacts
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: decmp-comment-*
          merge-multiple: true
          path: decmp-comment
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}

      - uses: decmp/upload-action@v1   # posts what it finds in decmp-comment/
```

The posting run reads only figures from those files and renders the comment itself.
