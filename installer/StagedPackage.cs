using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace RiA.Installer
{
    internal sealed class StagedPackage : IDisposable
    {
        private static readonly Regex PackageName = new Regex(@"^RiA-\d+\.\d+\.\d+-x64\.msi$", RegexOptions.IgnoreCase);
        private readonly string root;
        private readonly SafeFileHandle folder;
        private FileStream operation;
        private FileStream payload;
        private bool createdPayload;
        public string Path { get; private set; }

        public StagedPackage(CancellationToken cancellation)
        {
            root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "RiA-Setup");
            Directory.CreateDirectory(root);
            // Keep the verified source directory and file in place while MSI reads them.
            folder = OpenFolder(root, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            try
            {
                if (folder.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (IsReparsePoint(root)) throw new IOException("安装临时目录必须是普通文件夹。");
                try
                {
                    operation = new FileStream(System.IO.Path.Combine(root, "active.lock"), FileMode.CreateNew,
                        FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose);
                }
                catch (IOException error)
                {
                    var code = error.HResult & 0xffff;
                    if (code == 32 || code == 80 || code == 183) throw new Win32Exception(1618, "已有安装程序正在运行。");
                    throw;
                }
                foreach (var previous in Directory.EnumerateFiles(root, "RiA-*-x64.msi"))
                {
                    if (PackageName.IsMatch(System.IO.Path.GetFileName(previous)) && !IsReparsePoint(previous))
                        File.Delete(previous);
                }
                Path = System.IO.Path.Combine(root, SetupBuild.PackageName);
                using (var output = new FileStream(Path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024))
                {
                    createdPayload = true;
                    using (var source = OpenEmbedded())
                    {
                        var buffer = new byte[1024 * 1024];
                        int read;
                        while ((read = source.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            cancellation.ThrowIfCancellationRequested();
                            output.Write(buffer, 0, read);
                        }
                    }
                }
                payload = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024);
                Verify(payload);
                cancellation.ThrowIfCancellationRequested();
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public static void VerifyEmbedded()
        {
            using (var source = OpenEmbedded()) Verify(source);
        }

        private static Stream OpenEmbedded()
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RiA.msi");
            if (stream == null) throw new InvalidDataException("安装包缺少 MSI 文件。");
            return stream;
        }

        private static void Verify(Stream source)
        {
            using (var sha = SHA256.Create())
            {
                var hash = BitConverter.ToString(sha.ComputeHash(source)).Replace("-", "");
                if (!String.Equals(hash, SetupBuild.PackageHash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("内置 MSI 文件校验失败。请重新下载安装程序。");
            }
        }

        private static bool IsReparsePoint(string path)
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }

        public void Dispose()
        {
            if (payload != null) payload.Dispose();
            if (createdPayload)
            {
                try { File.Delete(Path); }
                catch (IOException) { } // A later Setup session can remove an abandoned payload.
                catch (UnauthorizedAccessException) { }
            }
            if (operation != null) operation.Dispose();
            folder.Dispose();
            if (operation != null)
            {
                try { Directory.Delete(root); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern SafeFileHandle OpenFolder(string path, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
    }
}
