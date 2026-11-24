---
name: unica-bb
description: Use Unica for 1C development in the current BB environment, including source navigation, platform help and verification.
---

# Unica in BB

Use the BB tools `unica_tools` and `unica_call`. With an unknown source address start with `unica.view` and an empty arguments object. Use the addresses returned by Unica. Keep the selected project and workspace for the rest of the operation.

Call `unica_tools` to obtain the exact schemas. An execution token confirms which plan Unica will apply. BB may present an additional confirmation for execution. When a task is returned call `unica.task.result` with its ID from the original environment.

Follow the repository's BSL Flow workflow when present. Select the relevant official Unica skill if it is available. For instructions referring to a native MCP operation, call the same logical name through `unica_call`. Fetch referenced documentation with `unica.docs` when supported. Keep one Unica route in the agent profile.
