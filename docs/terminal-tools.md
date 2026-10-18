# Desktop terminal tool

RiA includes `runTerminalCommand` for non-interactive Windows PowerShell commands.
It uses the same tool registry, assistant tool restrictions, per-call approvals
and execution records as other chat tools. It is unavailable in the web runtime.

## Enable and use

1. Open **文件权限** beside **执行记录** above the chat composer (or
   **Settings → File access**), choose
   a working folder and explicitly grant access. Choosing a folder alone does
   not authorize it. These machine-local permissions apply across conversations.
2. Choose **开启终端** for that folder and confirm the separate terminal permission.
3. In a conversation with a model that supports tools, ask for a command, for
   example: “在已授权的项目目录运行 `Get-ChildItem`，列出文件并解释结果。”
4. Review the full PowerShell command, canonical working directory and timeout,
   then approve or reject it. Nothing executes before approval.
5. Expand the tool result to see live stdout, stderr and the exit code. Use
   **停止命令** to stop a long command. Stopping the chat request, cancelling its
   execution record, disabling terminal permission or revoking the folder also
   stops the associated command.

Conversations created from templates retain their tool allowlist. Add
**执行终端命令** to a custom template if needed; existing templates do not gain
terminal permission automatically.

## Authority and limits

Terminal permission is separate from file-tool permission and defaults to off,
including for folders granted before upgrading. Commands run as the current
Windows user. The working directory is **not a filesystem or network sandbox**;
a command can access files outside it or start programs. Existing file-tool
restrictions do not restrict PowerShell. Do not put credentials into commands.
The child receives an allowlist of OS environment variables, excluding RiA's
API keys, database configuration and local service credentials. This does not
prevent a command from reading files or other resources available to the user.

Each command starts a fresh Windows PowerShell process without a profile or
interactive input. Shell variables and current-directory changes do not persist
between calls. Administrator prompts and interactive terminal programs are not
supported. The configured timeout is 1–600 seconds (default 120); the remaining
execution-run deadline can shorten it. At most two commands run concurrently.
Combined captured output is limited to 64 KiB and is explicitly marked when
truncated. Output and command text are saved with the chat and sent to its model.
Terminal results are not automatically saved as knowledge or memory.

A Windows Job Object stops ordinary child processes when the shell is stopped
or ends. A parent-process watcher ends the shell when the local service exits.
This is process cleanup, not a security sandbox; processes created indirectly by
external services are outside that ordinary descendant relationship.

Live session records are process-local, limited to 24 and retained for up to
30 minutes after completion. After restart the chat's persisted result remains
readable; interrupted commands never resume automatically. Restoring a portable
backup revokes directory permissions, including terminal permission, so old
approvals cannot execute against restored grants.

The isolated test runtime uses PowerShell on Windows and a non-interactive `sh`
process group on other platforms to exercise CI contracts. This does not enable
terminal execution in non-Windows production builds.
