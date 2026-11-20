using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;

namespace RiA.Installer
{
    internal sealed class SetupProgram
    {
        private const int Failed = 1603;
        private const int Cancelled = 1602;
        private readonly bool passive;
        private readonly string log;
        private readonly string updateRoot;
        private readonly SetupWindow setup;
        private string directory;
        private int exitCode = Cancelled;

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "-verify-payload")
            {
                try { StagedPackage.VerifyEmbedded(); return 0; }
                catch { return Failed; }
            }

            bool passive = false;
            string log = null;
            try
            {
                for (int index = 0; index < args.Length; index++)
                {
                    switch (args[index].ToLowerInvariant())
                    {
                        case "-passive": passive = true; break;
                        case "-norestart": break; // Windows restart is always deferred.
                        case "-log":
                            if (log != null || ++index == args.Length) return 1639;
                            log = Path.GetFullPath(args[index]);
                            break;
                        default: return 1639;
                    }
                }
                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                var program = new SetupProgram(passive, log ?? Path.Combine(Path.GetTempPath(),
                    "RiA-Setup-" + Guid.NewGuid().ToString("N") + ".log"));
                program.setup.Window.Loaded += (sender, eventArgs) => program.Detect();
                app.Run(program.setup.Window);
                return program.exitCode;
            }
            catch (Exception error)
            {
                if (log != null) AppendLog(log, error.ToString());
                return Failed;
            }
        }

        private SetupProgram(bool passive, string log)
        {
            this.passive = passive;
            this.log = log;
            updateRoot = passive ? Environment.GetEnvironmentVariable("RIA_SETUP_UPDATE_ROOT") : null;
            setup = new SetupWindow();
        }

        private void Detect()
        {
            try
            {
                var installed = InstalledProduct.Find(SetupBuild.UpgradeCode);
                var currentLocation = CheckLocation(installed);
                if (installed != null && installed.Version >= SetupBuild.Version)
                {
                    directory = currentLocation;
                    Finish(0, "RiA 已安装", "当前版本为 " + installed.Version + "。", true);
                    return;
                }
                var suggested = currentLocation ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RiA");
                if (passive) StartInstall(suggested, currentLocation);
                else setup.Ready(suggested, installed != null, selected => StartInstall(selected, currentLocation));
            }
            catch (Exception error) { Fail(Failed, error.Message); }
        }

        private string CheckLocation(InstalledProduct installed)
        {
            var actual = installed == null ? null : SetupWindow.NormalizeLocation(installed.Directory ?? "");
            if (updateRoot != null && (actual == null || !SameDirectory(actual, SetupWindow.NormalizeLocation(updateRoot))))
            {
                AppendLog(log, "The installed MSI directory does not match the requested update directory.");
                throw new InvalidOperationException("当前安装目录已变更，无法在原位置更新 RiA。");
            }
            if (installed != null && actual == null)
                throw new InvalidOperationException("无法确认当前安装目录。请查看安装日志。");
            return actual;
        }

        private static bool SameDirectory(string a, string b)
        {
            return String.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        private async void StartInstall(string selected, string previousLocation)
        {
            var owner = new WindowInteropHelper(setup.Window).Handle;
            directory = selected;
            using (var cancel = new CancellationTokenSource())
            {
                bool finishing = false;
                setup.Working("正在安装 RiA", "正在准备安装文件", () => { cancel.Cancel(); setup.Cancelling(); });
                var progress = new Progress<MsiProgress>(status =>
                {
                    if (finishing) return;
                    if (status.Completed)
                    {
                        finishing = true;
                        setup.Working("正在安装 RiA", "正在完成安装", null, true);
                    }
                    else if (!cancel.IsCancellationRequested)
                        setup.ReportProgress("正在应用安装更改", status.Percentage);
                });
                try
                {
                    var result = await Task.Run(() =>
                    {
                        using (var staged = new StagedPackage(cancel.Token))
                        {
                            var installed = InstalledProduct.Find(SetupBuild.UpgradeCode);
                            var currentLocation = CheckLocation(installed);
                            if (!SameDirectory(previousLocation, currentLocation))
                                throw new InvalidOperationException("安装状态已变更。请重新打开安装程序。");
                            if (installed != null && installed.Version >= SetupBuild.Version)
                                return new MsiResult(0, null);
                            cancel.Token.ThrowIfCancellationRequested();
                            return WindowsInstaller.Install(staged.Path, directory, log, owner, cancel.Token, progress);
                        }
                    });
                    if (result.Code == 0)
                        Finish(0, "安装完成", "RiA 已安装到 " + directory, true);
                    else if (result.Code == 3010 || result.Code == 1641)
                        Finish(result.Code, "安装完成，需要重启", "请保存正在进行的工作，重启后再打开 RiA。", false);
                    else if (result.Code == Cancelled || result.Code == 1223)
                        Finish(Cancelled, "安装已取消", "你可以重新打开安装程序。", false);
                    else
                        Fail(result.Code, result.Message ?? "Windows 安装程序返回错误。");
                }
                catch (OperationCanceledException)
                {
                    Finish(Cancelled, "安装已取消", "你可以重新打开安装程序。", false);
                }
                catch (Win32Exception error) { Fail(error.NativeErrorCode, error.Message); }
                catch (Exception error) { Fail(Failed, error.Message); }
                finally { finishing = true; }
            }
        }

        private void Fail(int code, string message)
        {
            exitCode = code == 0 ? Failed : code;
            var detail = message + " (" + exitCode.ToString(CultureInfo.InvariantCulture) + ")";
            if (!File.Exists(log)) AppendLog(log, detail);
            if (passive) { setup.Close(); return; }
            var hasLog = File.Exists(log);
            setup.Finish("安装未完成", detail, "关闭", setup.Close,
                hasLog ? "查看日志" : null, hasLog ? (Action)(() => SetupWindow.Open(log)) : null);
        }

        private void Finish(int code, string title, string message, bool offerLaunch)
        {
            exitCode = code;
            if (passive && code != 3010 && code != 1641) { setup.Close(); return; }
            var executable = directory == null ? null : Path.Combine(directory, "RiA.exe");
            if (offerLaunch && executable != null && File.Exists(executable))
                setup.Finish(title, message, "打开 RiA", () => { SetupWindow.Open(executable, directory); setup.Close(); }, "关闭", setup.Close);
            else
                setup.Finish(title, message, "关闭", setup.Close);
        }

        private static void AppendLog(string path, string message)
        {
            try { File.AppendAllText(path, message + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
