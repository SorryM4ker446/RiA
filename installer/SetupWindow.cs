using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Forms = System.Windows.Forms;

namespace RiA.Installer
{
    internal sealed class SetupWindow
    {
        private readonly Window window;
        private readonly TextBox location;
        private readonly Button install;
        private readonly Button primary;
        private readonly Button secondary;
        private readonly Button close;
        private readonly TextBlock locationNote;
        private readonly TextBlock heading;
        private readonly TextBlock phase;
        private readonly TextBlock percent;
        private readonly TextBlock details;
        private readonly ProgressBar progress;
        private readonly FrameworkElement installPanel;
        private readonly FrameworkElement statusPanel;
        private readonly FrameworkElement progressRow;
        private readonly FrameworkElement actions;
        private Action primaryAction;
        private Action secondaryAction;
        private Action<string> beginInstall;
        private Action cancelInstall;
        private bool waitForInstall;

        public SetupWindow()
        {
            using (var layout = Resource("Setup.xaml"))
                window = (Window)XamlReader.Load(layout);
            if (SystemParameters.HighContrast)
            {
                window.Resources["Surface"] = SystemColors.WindowBrush;
                window.Resources["Control"] = SystemColors.WindowBrush;
                window.Resources["Border"] = SystemColors.WindowTextBrush;
                window.Resources["Ink"] = SystemColors.WindowTextBrush;
                window.Resources["Muted"] = SystemColors.WindowTextBrush;
                window.Resources["Error"] = SystemColors.WindowTextBrush;
                window.Resources["Primary"] = SystemColors.HighlightBrush;
                window.Resources["PrimaryInk"] = SystemColors.HighlightTextBrush;
            }
            Find<Image>("Mark").Source = BrandMark(((SolidColorBrush)window.Resources["Ink"]).Color);
            Find<Border>("CaptionBar").MouseLeftButtonDown += (sender, args) =>
            {
                if (args.LeftButton == MouseButtonState.Pressed) window.DragMove();
            };
            close = Find<Button>("CloseButton");
            close.Click += (sender, args) => window.Close();
            window.Closing += (sender, args) =>
            {
                if (!waitForInstall) return;
                args.Cancel = true;
                if (cancelInstall != null) cancelInstall();
            };
            window.PreviewKeyDown += (sender, args) =>
            {
                if (args.Key != Key.Escape) return;
                args.Handled = true;
                window.Close();
            };
            location = Find<TextBox>("Location");
            locationNote = Find<TextBlock>("LocationNote");
            install = Find<Button>("Install");
            primary = Find<Button>("Primary");
            secondary = Find<Button>("Secondary");
            heading = Find<TextBlock>("Heading");
            phase = Find<TextBlock>("Phase");
            percent = Find<TextBlock>("Percent");
            details = Find<TextBlock>("Details");
            progress = Find<ProgressBar>("ProgressBar");
            installPanel = Find<FrameworkElement>("InstallPanel");
            statusPanel = Find<FrameworkElement>("StatusPanel");
            progressRow = Find<FrameworkElement>("ProgressRow");
            actions = Find<FrameworkElement>("Actions");
            Find<Button>("Browse").Click += (sender, args) => BrowseForLocation();
            install.Click += (sender, args) => Submit();
            primary.Click += (sender, args) => { if (primaryAction != null) primaryAction(); };
            secondary.Click += (sender, args) => { if (secondaryAction != null) secondaryAction(); };
        }

        public Window Window { get { return window; } }

        public void Close()
        {
            SetCloseBehavior(null, false);
            window.Close();
        }

        public void Ready(string directory, bool upgrading, Action<string> start)
        {
            SetCloseBehavior(null, false);
            beginInstall = start;
            heading.Text = upgrading ? "升级 RiA" : "安装 RiA";
            location.Text = directory;
            location.IsReadOnly = upgrading;
            Find<Button>("Browse").IsEnabled = !upgrading;
            locationNote.Foreground = (Brush)window.Resources["Muted"];
            locationNote.Text = upgrading ? "将在现有位置升级，保留工作区数据" : "安装需要管理员权限";
            install.Content = upgrading ? "升级" : "安装";
            installPanel.Visibility = Visibility.Visible;
            statusPanel.Visibility = Visibility.Collapsed;
            install.Focus();
        }

        public void Working(string title, string message, Action cancel, bool mustWait = false)
        {
            SetCloseBehavior(cancel, mustWait || cancel != null);
            heading.Text = title;
            ShowStatus(true);
            progress.IsIndeterminate = true;
            phase.Text = message;
            percent.Text = "";
            details.Visibility = Visibility.Collapsed;
            SetActions(null, null, cancel == null ? null : "取消", cancel);
            if (cancel != null) secondary.Focus();
        }

        public void ReportProgress(string message, int? percentage)
        {
            phase.Text = message;
            progress.IsIndeterminate = !percentage.HasValue;
            if (percentage.HasValue)
                progress.Value = Math.Max(0, Math.Min(100, percentage.Value));
            percent.Text = percentage.HasValue ? progress.Value.ToString("0", CultureInfo.InvariantCulture) + "%" : "";
        }

        public void Cancelling()
        {
            heading.Text = "正在取消";
            ReportProgress("等待安装程序结束", null);
            SetCloseBehavior(null, true);
            secondary.IsEnabled = false;
            actions.Visibility = Visibility.Collapsed;
        }

        public void Finish(string title, string message, string label, Action action, string extraLabel = null, Action extra = null)
        {
            SetCloseBehavior(null, false);
            heading.Text = title;
            ShowStatus(false);
            details.Text = message;
            details.Visibility = String.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
            SetActions(label, action, extraLabel, extra);
            primary.Focus();
        }

        private void SetCloseBehavior(Action cancel, bool wait)
        {
            cancelInstall = cancel;
            waitForInstall = wait;
            close.IsEnabled = !wait || cancel != null;
        }

        private void ShowStatus(bool showProgress)
        {
            installPanel.Visibility = Visibility.Collapsed;
            statusPanel.Visibility = Visibility.Visible;
            progressRow.Visibility = progress.Visibility = showProgress ? Visibility.Visible : Visibility.Collapsed;
        }

        private void SetActions(string label, Action action, string extraLabel, Action extra)
        {
            primaryAction = action;
            secondaryAction = extra;
            primary.Content = label;
            primary.IsDefault = action != null;
            primary.Visibility = action == null ? Visibility.Collapsed : Visibility.Visible;
            secondary.Content = extraLabel;
            secondary.IsEnabled = extra != null;
            secondary.Margin = action == null ? new Thickness(0) : new Thickness(0, 0, 8, 0);
            secondary.Visibility = extra == null ? Visibility.Collapsed : Visibility.Visible;
            actions.Visibility = action == null && extra == null ? Visibility.Collapsed : Visibility.Visible;
        }

        private void BrowseForLocation()
        {
            using (var dialog = new Forms.FolderBrowserDialog { Description = "选择 RiA 的安装位置", SelectedPath = location.Text })
                if (dialog.ShowDialog(new WindowOwner(window)) == Forms.DialogResult.OK)
                    location.Text = dialog.SelectedPath;
        }

        private void Submit()
        {
            var directory = NormalizeLocation(location.Text);
            if (directory == null)
            {
                locationNote.Foreground = (Brush)window.Resources["Error"];
                locationNote.Text = "请选择本地磁盘上的文件夹，且路径不能是磁盘根目录。";
                location.Focus();
                return;
            }
            var start = beginInstall;
            beginInstall = null;
            if (start != null) start(directory);
        }

        internal static string NormalizeLocation(string input)
        {
            var path = input.Trim();
            if (path.Length < 4 || path[1] != ':' || path[2] != '\\' || !Char.IsLetter(path[0]))
                return null;
            try
            {
                var fullPath = Path.GetFullPath(path).TrimEnd('\\');
                var root = Path.GetPathRoot(fullPath);
                if (root == null || fullPath.Length <= root.Length || File.Exists(fullPath)
                    || new DriveInfo(root).DriveType != DriveType.Fixed)
                    return null;
                return fullPath;
            }
            catch (Exception error)
            {
                if (error is IOException || error is ArgumentException || error is NotSupportedException || error is UnauthorizedAccessException)
                    return null;
                throw;
            }
        }

        internal static void Open(string file, string directory = null)
        {
            try
            {
                if (File.Exists(file))
                {
                    Process.Start(new ProcessStartInfo(file) { UseShellExecute = true, WorkingDirectory = directory ?? Path.GetDirectoryName(file) });
                    return;
                }
            }
            catch (System.ComponentModel.Win32Exception) { }
            MessageBox.Show("请在资源管理器中打开：" + Environment.NewLine + file, "RiA 安装程序");
        }

        private T Find<T>(string name) where T : class { return (T)window.FindName(name); }

        private static Stream Resource(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        }

        // Use the ink in the shipped icon as the mask, so the mark keeps its exact orbit
        // and can take the foreground color without the launcher icon's white tile.
        private static BitmapSource BrandMark(Color ink)
        {
            using (var resource = Resource("RiA-icon.png"))
            {
                var source = BitmapFrame.Create(resource, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                var inset = source.PixelWidth * 8 / 100;
                var crop = new CroppedBitmap(source, new Int32Rect(inset, inset, source.PixelWidth - 2 * inset, source.PixelHeight - 2 * inset));
                var converted = new FormatConvertedBitmap(crop, PixelFormats.Bgra32, null, 0);
                var stride = converted.PixelWidth * 4;
                var pixels = new byte[stride * converted.PixelHeight];
                converted.CopyPixels(pixels, stride, 0);
                for (var offset = 0; offset < pixels.Length; offset += 4)
                {
                    var mask = 255 - Math.Max(pixels[offset], Math.Max(pixels[offset + 1], pixels[offset + 2]));
                    pixels[offset + 3] = (byte)(pixels[offset + 3] * mask / 255);
                    pixels[offset] = ink.B;
                    pixels[offset + 1] = ink.G;
                    pixels[offset + 2] = ink.R;
                }
                var mark = BitmapSource.Create(converted.PixelWidth, converted.PixelHeight, 96, 96, PixelFormats.Bgra32, null, pixels, stride);
                mark.Freeze();
                return mark;
            }
        }

        private sealed class WindowOwner : Forms.IWin32Window
        {
            public WindowOwner(Window owner) { Handle = new System.Windows.Interop.WindowInteropHelper(owner).Handle; }
            public IntPtr Handle { get; private set; }
        }
    }
}
