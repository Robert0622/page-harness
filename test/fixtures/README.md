# Agent CLI fixtures

Recorded from the real CLIs unless the file name says `mocked`.

| File | Source |
| --- | --- |
| `codebuddy-help.txt` | `codebuddy --help`, @tencent-ai/codebuddy-code 2.164.0 |
| `codebuddy-unauthenticated.jsonl` | real headless run without a login (init ×2, status, assistant, failed result) |
| `codebuddy-resume-missing.jsonl` | real `--resume <unknown id>` |
| `codebuddy-turn.mocked.jsonl` | **mocked**: a signed-in turn (deltas, MCP + Edit tools, result), built from the Claude-compatible stream-json frames found in the CodeBuddy bundle |
| `opencode-tools.jsonl` | real `opencode run --format json --thinking` (bash, write, read), opencode-ai 1.18.35, free `opencode/big-pickle` model |
| `opencode-mcp.jsonl` | real run calling a bearer-protected HTTP MCP server configured through `OPENCODE_CONFIG_CONTENT` |
| `opencode-resume.jsonl` | real `--session <id>` resume with a different `--model` and `--variant` |
| `opencode-error.jsonl` | real error event (`--model nope/nada`) |
| `opencode-models.txt`, `opencode-models-verbose.txt` | real `opencode models [--verbose]` |
