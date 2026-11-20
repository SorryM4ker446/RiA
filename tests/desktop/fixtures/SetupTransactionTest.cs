using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using RiA.Installer;

internal static class SetupTransactionTest
{
    private static int Main(string[] args)
    {
        var previous = args[0];
        var location = args[1];
        var oldProduct = args[2];
        var newProduct = args[3];
        var logs = args[4];
        var perMachine = args[5] == "perMachine";
        var nextPackage = args[6];
        var nextProduct = args[7];
        var oldFile = Path.Combine(location, "old.txt");
        var newFile = Path.Combine(location, "new.txt");
        var nextFile = Path.Combine(location, "next.txt");
        var sentinel = Path.Combine(location, "keep.txt");
        var staging = Path.Combine(Path.GetTempPath(), "RiA-Setup");
        try
        {
            MsiExec("/i " + Quote(previous) + " APPLICATIONROOTDIRECTORY=" + Quote(location), Path.Combine(logs, "legacy-install.log"));
            Require(File.Exists(oldFile), "The standalone MSI did not install to the supplied directory.");
            File.WriteAllText(sentinel, "user file");

            var showedProgress = false;
            var installed = Install(location, Path.Combine(logs, "upgrade.log"), CancellationToken.None, state =>
            {
                if (state.Percentage > 0) showedProgress = true;
            });
            Require(installed.Code == 0 && showedProgress, "Setup upgrade or its native progress failed. Result: " + installed.Code);
            Require(File.Exists(newFile) && !File.Exists(oldFile), "Setup did not replace the previous version in place.");
            Require(MsiQueryProductState(newProduct) == 5 && MsiQueryProductState(oldProduct) != 5,
                "Only the upgraded product should be registered.");
            Require(!Directory.Exists(staging), "Successful Setup left its payload staged.");

            MsiExec("/i " + Quote(nextPackage) + " APPLICATIONROOTDIRECTORY=" + Quote(location), Path.Combine(logs, "standalone-upgrade.log"));
            Require(MsiQueryProductState(nextProduct) == 5 && MsiQueryProductState(newProduct) != 5 &&
                File.Exists(nextFile) && !File.Exists(newFile), "Standalone MSI could not upgrade a Setup installation in place.");
            MsiExec("/x " + nextProduct, Path.Combine(logs, "uninstall.log"));
            Require(!File.Exists(nextFile) && File.ReadAllText(sentinel) == "user file", "Uninstall did not preserve the unrelated file.");

            Directory.CreateDirectory(staging);
            var abandoned = Path.Combine(staging, "RiA-1.0.0-x64.msi");
            File.WriteAllText(abandoned, "abandoned setup payload");
            var reinstalled = Install(location, Path.Combine(logs, "reinstall.log"), CancellationToken.None, null);
            Require(reinstalled.Code == 0 && File.Exists(newFile) && File.ReadAllText(sentinel) == "user file", "Setup reinstall failed.");
            Require(!Directory.Exists(staging), "Setup did not recover abandoned staging or clean the new payload.");
            MsiExec("/x " + newProduct, Path.Combine(logs, "final-uninstall.log"));
            Require(!File.Exists(newFile) && File.Exists(sentinel), "Final uninstall did not clean the installed files.");

            MsiExec("/i " + Quote(previous) + " APPLICATIONROOTDIRECTORY=" + Quote(location), Path.Combine(logs, "prepare-cancel.log"));
            var cancellationReached = false;
            using (var cancel = new CancellationTokenSource())
            {
                var result = Install(location, Path.Combine(logs, "cancel-upgrade.log"), cancel.Token, state =>
                {
                    if (state.Completed || File.Exists(oldFile)) return;
                    cancellationReached = true;
                    cancel.Cancel();
                });
                Require(cancellationReached && result.Code == 1602,
                    "Expected Windows Installer to accept cancellation after the old files were removed. Result: " + result.Code);
            }
            Require(File.Exists(oldFile) && !File.Exists(newFile), "Rollback did not restore the previous installation.");
            Require(MsiQueryProductState(newProduct) != 5, "The cancelled update was registered as installed.");
            Require(!Directory.Exists(staging), "Cancelled Setup left its payload staged.");
            if (MsiQueryProductState(oldProduct) != 5)
            {
                Require(!perMachine, "Rollback did not restore the previous per-machine product registration.");
                Console.WriteLine("Per-user rollback restored files; product registration requires the elevated fixture.");
            }
            Console.WriteLine("Passed {0} MSI progress, in-place upgrade, cancellation/file rollback, uninstall and reinstall.", args[5]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            // These IDs are generated for each fixture and cannot refer to RiA.
            Cleanup(nextProduct, Path.Combine(logs, "cleanup-next.log"));
            Cleanup(newProduct, Path.Combine(logs, "cleanup-new.log"));
            Cleanup(oldProduct, Path.Combine(logs, "cleanup-old.log"));
        }
    }

    private static MsiResult Install(string location, string log, CancellationToken token, Action<MsiProgress> onProgress)
    {
        using (var payload = new StagedPackage(token))
        {
            return WindowsInstaller.Install(payload.Path, location, log, IntPtr.Zero, token,
                onProgress == null ? null : new InlineProgress(onProgress));
        }
    }

    private sealed class InlineProgress : IProgress<MsiProgress>
    {
        private readonly Action<MsiProgress> report;
        public InlineProgress(Action<MsiProgress> report) { this.report = report; }
        public void Report(MsiProgress value) { report(value); }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Cleanup(string product, string log)
    {
        if (MsiQueryProductState(product) != -1) MsiExec("/x " + product, log, true);
    }

    private static void MsiExec(string action, string log, bool cleanup = false)
    {
        var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        using (var process = Process.Start(new ProcessStartInfo(Path.Combine(system, "msiexec.exe"),
            action + " /qn /norestart /L*V " + Quote(log)) { UseShellExecute = false }))
        {
            if (!process.WaitForExit(30000))
            {
                process.Kill();
                throw new TimeoutException("Fixture MSI operation did not finish. See " + log);
            }
            var status = process.ExitCode;
            Require(status == 0 || (cleanup && status == 1605), "Fixture MSI returned " + status + ". See " + log);
        }
    }

    private static string Quote(string value) { return "\"" + value + "\""; }

    [DllImport("msi.dll", EntryPoint = "MsiQueryProductStateW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MsiQueryProductState(string product);
}
