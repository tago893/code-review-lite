/** The MCP server's name in the OpenCode config; OpenCode shows its tools to the model as `<server>_<tool>`. */
export const SERVER_NAME = "cra";

/** The only tools a reviewer may use, as OpenCode names them. OpenCode's own read, grep, glob and list are denied. */
export const APPROVED_TOOL_IDS: readonly string[] = Object.freeze([`${SERVER_NAME}_read`, `${SERVER_NAME}_grep`, `${SERVER_NAME}_glob`, `${SERVER_NAME}_list`]);
