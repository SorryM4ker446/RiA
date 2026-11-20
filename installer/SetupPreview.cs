using System;
using System.IO;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace RiA.Installer
{
    internal static class SetupPreview
    {
        private const string DefaultLocation = @"C:\Program Files\RiA";

        [STAThread]
        private static int Main(string[] args)
        {
            var app = new Application();
            var setup = new SetupWindow();
            if (args.Length == 1) return CaptureAndCheck(setup, args[0]);
            if (args.Length != 0) return 1;

            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(90) };
            var percentage = 0;
            Action reset = null;
            reset = () => setup.Ready(DefaultLocation, false, directory =>
            {
                percentage = 0;
                setup.Working("正在安装 RiA", "正在准备安装", () =>
                {
                    timer.Stop();
                    setup.Finish("安装已取消", "演示安装已停止。", "返回", reset);
                });
                timer.Start();
            });
            timer.Tick += (sender, args2) =>
            {
                percentage = Math.Min(percentage + 3, 100);
                setup.ReportProgress("正在应用安装更改", percentage);
                if (percentage < 100) return;
                timer.Stop();
                setup.Finish("安装完成", "预览演示，未更改系统。", "关闭", setup.Window.Close, "重新预览", reset);
            };
            setup.Window.Title += "（预览）";
            reset();
            return app.Run(setup.Window);
        }

        private static int CaptureAndCheck(SetupWindow setup, string target)
        {
            Directory.CreateDirectory(target);
            try
            {
                string submitted = null;
                setup.Ready(DefaultLocation, false, directory => submitted = directory);
                var path = (TextBox)setup.Window.FindName("Location");
                path.Text = @"C:\";
                Click(setup, "Install");
                if (submitted != null || !((TextBlock)setup.Window.FindName("LocationNote")).Text.Contains("根目录"))
                    throw new InvalidOperationException("A drive root must be rejected before submitting.");
                setup.Ready(DefaultLocation, false, directory => submitted = directory);
                Click(setup, "Install");
                if (submitted != DefaultLocation) throw new InvalidOperationException("The chosen path did not reach installation.");
                var installHeight = Render(setup.Window, Path.Combine(target, "install.png"));

                setup.Ready(DefaultLocation, true, directory => { });
                if (!path.IsReadOnly || ((Button)setup.Window.FindName("Browse")).IsEnabled)
                    throw new InvalidOperationException("An upgrade must keep the installed location.");
                Render(setup.Window, Path.Combine(target, "upgrade.png"));
                var cancel = false;
                setup.Working("正在安装 RiA", "正在准备安装", () => { cancel = true; setup.Cancelling(); });
                setup.ReportProgress("正在应用安装更改", 48);
                var progressHeight = Render(setup.Window, Path.Combine(target, "progress.png"));
                Click(setup, "Secondary");
                if (!cancel || ((Button)setup.Window.FindName("Secondary")).IsEnabled ||
                    ((Button)setup.Window.FindName("CloseButton")).IsEnabled)
                    throw new InvalidOperationException("Cancel must signal the installer and disable repeated cancellation while it waits.");
                var cancellingHeight = Render(setup.Window, Path.Combine(target, "cancelling.png"));
                if (cancellingHeight + 36 > progressHeight || progressHeight >= installHeight)
                    throw new InvalidOperationException("Progress and cancellation should shrink to the controls they show.");

                var logs = false;
                setup.Finish("安装未完成", "Windows 安装程序返回错误。", "关闭", () => { }, "查看日志", () => logs = true);
                Click(setup, "Secondary");
                if (!logs) throw new InvalidOperationException("The failure action did not open the installer log.");
                Render(setup.Window, Path.Combine(target, "failure.png"));
                setup.Finish("安装完成", "RiA 已安装到 " + DefaultLocation, "打开 RiA", () => { }, "关闭", () => { });
                Render(setup.Window, Path.Combine(target, "success.png"));

                var closed = false;
                setup.Window.Closed += (sender, args) => closed = true;
                setup.Working("正在安装 RiA", "正在完成安装", null, true);
                setup.Window.Close();
                if (closed) throw new InvalidOperationException("Closing must wait while Windows completes installation.");
                setup.Close();
                if (!closed) throw new InvalidOperationException("The installer must be able to close the passive window on completion.");
                return 0;
            }
            catch (Exception error)
            {
                File.WriteAllText(Path.Combine(target, "failure.txt"), error.ToString());
                return 1;
            }
        }

        private static void Click(SetupWindow setup, string control)
        {
            var button = (Button)setup.Window.FindName(control);
            var peer = new ButtonAutomationPeer(button);
            ((IInvokeProvider)peer.GetPattern(PatternInterface.Invoke)).Invoke();
            Dispatcher.CurrentDispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(() => { }));
        }

        private static int Render(Window window, string path)
        {
            var body = (UIElement)window.Content;
            body.UpdateLayout();
            body.InvalidateMeasure();
            body.Measure(new Size(window.Width, Double.PositiveInfinity));
            var size = new Size(window.Width, Math.Ceiling(body.DesiredSize.Height));
            body.Arrange(new Rect(size));
            body.UpdateLayout();
            var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(body);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var file = File.Create(path)) encoder.Save(file);
            return (int)size.Height;
        }
    }
}
