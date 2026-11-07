import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient } from 'vscode-languageclient/node';
import { createLaunchPlan, validateLaunchFiles, type LaunchPlan } from './config';
import { DoctorSessionManager } from './lifecycle';
import { DoctorProcess } from './process';
import { forwardSavedDocumentOpen } from './snapshot';

let sessions: DoctorSessionManager<LaunchPlan> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('TypeHTML Doctor', { log: true });
  context.subscriptions.push(output);
  const report = (error: unknown) => output.appendLine(error instanceof Error ? error.message : String(error));
  sessions = new DoctorSessionManager(async (plan) => {
    const checked = await validateLaunchFiles(plan);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(plan.root));
    const transport = new DoctorProcess(checked);
    const client = new LanguageClient('typehtml-doctor', 'TypeHTML Doctor (saved snapshots)', () => transport.launch(), {
      documentSelector: [{ scheme: 'file', language: 'html', pattern: { baseUri: vscode.Uri.file(plan.root).toString(), pattern: '**/*' } }],
      workspaceFolder: folder, outputChannel: output,
      initializationFailedHandler: () => false,
      errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => ({ action: CloseAction.DoNotRestart }) },
      middleware: {
        // Sending a clean 1–2 MiB buffer would exceed the server's 1 MiB RPC cap.
        didOpen: forwardSavedDocumentOpen,
      },
    });
    return {
      start: () => client.start(),
      stop: async () => { try { await client.stop(); } finally { await transport.close(); } },
      dispose: async () => { try { await client.dispose(); } finally { await transport.close(); } },
    };
  }, report);
  const refresh = async () => {
    const plans: LaunchPlan[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const settings = vscode.workspace.getConfiguration('typehtml', folder.uri);
      try {
        const plan = createLaunchPlan(folder.uri.fsPath, vscode.workspace.isTrusted, folder.uri.scheme, {
          doctorConfig: settings.get('doctorConfig'), cliPath: settings.get('cliPath'), nodePath: settings.get('nodePath'),
        });
        if (plan) plans.push(plan);
      } catch (error) { report(error); }
    }
    await sessions?.refresh(plans);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('typehtml.restartDoctor', refresh),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('typehtml')) void refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }),
    { dispose: () => { void sessions?.dispose(); } },
  );
  await refresh();
}

export async function deactivate(): Promise<void> {
  const active = sessions;
  sessions = undefined;
  await active?.dispose();
}
