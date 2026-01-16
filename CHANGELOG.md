# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.5] - 2026-01-16

### Fixed
- Handle streaming tool_calls without `index` by assigning a stable fallback index
- Improve tool name logging when tools define top-level `name`

## [0.4.4] - 2026-01-16

### Fixed
- Normalize `bin` path and repository URL for npm publish compatibility

## [0.4.3] - 2026-01-16

### Added
- Auto-enable tool bridging when tool-related fields are present in the request
- Extra logging to surface `allowTools` and `toolsPresent` per request
- Debug tool summary logging (types and sample names)

### Fixed
- Correct output_index mapping for streaming tool call events
- Filter non-function tools to avoid upstream schema errors

### Changed
- README guidance for MCP/tools troubleshooting and proxy startup

## [0.4.2] - 2026-01-16

### Changed
- Replaced the README with expanded setup, usage, and troubleshooting guidance
- Clarified Codex provider configuration and proxy endpoint usage

## [0.4.1] - 2026-01-16

### Added
- Tool calling support (MCP/function calls) when `ALLOW_TOOLS=1`
- Bridging for `function_call_output` items to Chat `role: tool` messages
- Streaming support for `delta.tool_calls` with proper Responses API events
- Non-streaming support for `msg.tool_calls` in final response
- Tool call events: `response.output_item.added` (function_call), `response.function_call_arguments.delta`, `response.function_call_arguments.done`
- Automated tool call test in test suite

### Changed
- `translateResponsesToChat()` now handles `type: function_call_output` items
- `streamChatToResponses()` now detects and emits tool call events
- `translateChatToResponses()` now includes `function_call` items in output array

### Fixed
- Tool responses (from MCP/function calls) are now correctly forwarded to upstream as `role: tool` messages
- Function call items are now properly included in `response.completed` output array

## [0.4.0] - Previous

### Added
- Initial release with Responses API to Chat Completions translation
- Streaming support with SSE
- Health check endpoint
- Zero-dependency implementation
