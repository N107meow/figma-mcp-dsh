[中文](./README.md) | [English](./README_EN.md)

# figma-mcp-dsh

`figma-mcp-dsh` is a read-only Figma plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It lets models inspect file structure, colors, typography, components, and styles, then render selected frames as images visible in the current conversation.

## Features

The plugin helps models understand designs without changing cloud files:

- Read Figma files, pages, and node trees
- Extract colors (including the stops of a gradient), type scales, layout properties, and dimensions
- Report auto-layout alignment and wrapping, masks, and rotation — so a tilted or clipped layer cannot be described as a straight, complete one
- Inspect local components, component sets, variants, and styles
- Export a selected frame and return it to the model as an image
- Limit traversal depth so large files do not consume the model context
- Return a summary and save the full result locally when output is too large
- Handle rate limits, expired tokens, and missing permissions

## Requirements

Install these dependencies before you add the plugin:

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Node.js 20 or later
- `pnpm`
- A Figma Personal Access Token (PAT) with access to the target file

The Figma token requires these read-only scopes:

```text
file_content:read
file_metadata:read
file_comments:read
file_dev_resources:read
```

## Installation and configuration

The following steps install the plugin in the DSH `web` profile and configure Figma access.

### 1. Install from GitHub

Install the plugin in your DSH profile:

```bash
cd ~/.dsh/profiles/web
pnpm add github:N107meow/figma-mcp-dsh
```

#### Other installation methods · npm

The plugin is also published to npm, and the registry version tracks this repository. If you prefer npm:

```bash
dsh plugin --profile web add figma-mcp-dsh
```

Or install it directly in the profile directory with `pnpm`:

```bash
cd ~/.dsh/profiles/web
pnpm add figma-mcp-dsh
```

After installing from npm, upgrade with:

```bash
dsh plugin --profile web update figma-mcp-dsh
```

#### Local development

Use a `link:` dependency instead when you develop the plugin locally:

```bash
cd ~/.dsh/profiles/web
pnpm add link:/absolute/path/to/figma-mcp-dsh
```

Local development also requires host packages that match your current DSH version. Run `npm run check:deps` in the plugin repository to verify the versions.

> **The plugin and DSH versions must match.** DSH validates the plugin's `peerDependencies`, and a mismatch makes the **installation fail outright** (`installation rejected: … is incompatible with dsh …`). If you see that message, the plugin is older than your DSH — upgrade the plugin. Do not work around it with `dsh plugin allow-version`: that exemption exists for "known incompatible, risk accepted", not for "the wrong version was installed".

### 2. Mount the plugin

Add this entry to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: figma
      name: figma-mcp-dsh
```

Changes to `cordis.patch.yml` load without a restart. Restart DSH after the first installation or any dependency update.

### 3. Configure the Figma token

Store the token in `~/.dsh/.credentials.yaml`:

```yaml
refs:
  FIGMA_TOKEN: your_figma_token_here
```

You can also set the `FIGMA_TOKEN` environment variable. The plugin resolves credentials for every operation, so replacing a token does not require a DSH restart.

Read the [Figma token setup guide](./docs/TOKEN_SETUP.md) for token creation, scope selection, and rotation instructions.

## Usage examples

After installation, paste a Figma file or node URL into a DSH conversation and describe what you need. For example:

```text
Analyze the layout, primary colors, and type scale in this Figma frame:
https://www.figma.com/design/your_file_key/project?node-id=12-345
```

The model selects the appropriate read operation for the task. You can also request a specific result:

```text
List the components and variants defined in this file.
Render node 101:202 and analyze its visual hierarchy.
List the color and text styles in this design file.
```

The plugin registers two model-facing tools:

| Tool | Purpose |
| --- | --- |
| `figma_capabilities` | Lists available operations; use `detail="full"` for complete parameter schemas |
| `figma_call` | Runs a read operation; select it with `op` and pass a Figma URL through `target` |

Example tool call:

```javascript
figma_call({
  op: "file_nodes",
  target: "https://www.figma.com/design/your_file_key/project?node-id=12-345",
})
```

## Seven supported operations

Every operation uses a read-only Figma endpoint and cannot change design files.

| `op` | Purpose | Rate-limit tier |
| --- | --- | --- |
| `file_meta` | Read the file name, version, modification time, and current role | Tier 3 |
| `file` | Read pages and top-level frame structure | Tier 1 |
| `file_nodes` | Read one or more node subtrees by node ID | Tier 1 |
| `image_render` | Export selected nodes and return images to the model | Tier 1 |
| `components` | List components and variants defined in the current file | Tier 1 |
| `component_sets` | List component sets defined in the current file | Tier 1 |
| `styles` | List fill, text, effect, and grid styles | Tier 1 |

`file_nodes` is the recommended starting point for a single page or frame. When a URL includes `node-id`, the plugin resolves that node and applies `depth=2` unless you provide a depth.

## Security and privacy

Read-only access and credential protection are architectural constraints:

- The capability registry only declares `GET` requests, and dispatch checks each method again
- The plugin rejects automatic redirects so the token cannot reach a non-Figma domain
- Image downloads from signed Figma URLs do not include the Figma token
- Logs and error results redact known credentials
- Large results and rendered images stay in the local `.figma/` directory, which Git ignores
- Git ignores `.env.*`, `.credentials.yaml`, and recorded-data directories
- `npm run check:secrets` scans pending files and Git history for tokens and private identifiers

Do not commit real Figma tokens, private file URLs, or exported design content.

## Frequently asked questions

These answers cover the most common installation errors and runtime behavior.

### Why does the plugin return `unconfigured`?

The plugin cannot resolve `FIGMA_TOKEN`. Check `~/.dsh/.credentials.yaml` or the environment variables available to the current process.

### Why does the plugin return `token_invalid`?

The token has expired or was revoked. Create a token and replace the old value. The next operation will use the new credential.

### Why does the plugin return `forbidden_scope`?

The token lacks a required permission. Create a token with the four read-only scopes listed in the requirements.

### Why does the plugin return `credential_error`?

DSH's own credential service failed while resolving the token — a credentials file that is unreadable or no longer valid YAML, or a service that is not mounted — so no request was sent to Figma. This differs from `unconfigured`: that means the service answered "no token", while this means the service did not answer at all. Check that `~/.dsh/.credentials.yaml` is readable and is valid YAML, confirm it holds the entry you expect, and restart DSH if the file looks fine.

### Why does a request wait before running?

The plugin uses conservative defaults to protect your Figma API quota. Requests wait instead of being dropped when the quota is empty. After a `429` response, the plugin adjusts its limits from the response headers.

### Why is there no Variables operation?

The Figma Variables API is limited to Enterprise organizations and requires an additional scope. The plugin does not expose this operation.

### What happens when a result is too large?

The plugin reduces the traversal depth and retries once. If the result remains too large, it returns a structural summary and writes the full result to the local `.figma/` directory.

### Where are rendered images stored?

Rendered images are saved under `.figma/images/`, copied to DSH attachment storage, and returned to the current conversation as image content.

### How do I verify a local development build?

Run this command in the repository root:

```bash
npm run verify
```

The command checks host dependencies, read-only boundaries, sensitive data, and the test suite.

This project is available under the [MIT License](./LICENSE). Report problems through [GitHub Issues](https://github.com/N107meow/figma-mcp-dsh/issues). This project is not affiliated with or endorsed by Figma.
