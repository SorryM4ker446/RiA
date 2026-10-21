/** Tools that only use a folder's terminal access: available with it, and offered wherever runTerminalCommand is allowed. */
export const TERMINAL_COMPANION_TOOLS = new Set(["readTerminalLog", "readProjectFile", "editProjectFile"]);
/** Tools that address folders by grantId and are told which folders are terminal-enabled. */
export const TERMINAL_FOLDER_TOOLS = new Set(["runTerminalCommand", "readProjectFile", "editProjectFile"]);
