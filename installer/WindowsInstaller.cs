using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace RiA.Installer
{
    internal sealed class MsiResult
    {
        public readonly int Code;
        public readonly string Message;

        public MsiResult(int code, string message) { Code = code; Message = message; }
    }

    internal sealed class MsiProgress
    {
        public readonly int? Percentage;
        public readonly bool Completed;

        public MsiProgress(int? percentage, bool completed = false) { Percentage = percentage; Completed = completed; }
    }

    internal static class WindowsInstaller
    {
        private const int Error = 0x01000000;
        private const int FatalExit = 0x00000000;
        private const int FilesInUse = 0x05000000;
        private const int OutOfDiskSpace = 0x07000000;
        private const int ActionStart = 0x08000000;
        private const int ActionData = 0x09000000;
        private const int Progress = 0x0A000000;
        private const int RestartManagerFilesInUse = 0x19000000;
        private const int IdOk = 1;
        private const int IdCancel = 2;
        private const uint UiNoneWithElevation = 2 | 0x200;
        private const uint VerboseLog = 0x3fff;

        public static MsiResult Install(string path, string target, string log, IntPtr owner,
            CancellationToken cancellation, IProgress<MsiProgress> progress)
        {
            var state = new MessageHandler(cancellation, progress);
            ExternalUi callback = state.Handle;
            var previousLevel = MsiSetInternalUI(UiNoneWithElevation, ref owner);
            IntPtr previousHandler;
            var status = MsiSetExternalUIRecord(callback, MessageFilter(), IntPtr.Zero, out previousHandler);
            try
            {
                if (status != 0) throw new Win32Exception((int)status);
                status = MsiEnableLog(VerboseLog, log, 0);
                if (status != 0) throw new Win32Exception((int)status);
                cancellation.ThrowIfCancellationRequested();
                var result = (int)MsiInstallProduct(path, "REBOOT=ReallySuppress APPLICATIONROOTDIRECTORY=\"" + target + "\"");
                if (progress != null && (result == 0 || result == 3010 || result == 1641))
                    progress.Report(new MsiProgress(null, true));
                return new MsiResult(result == 1602 && state.ResourceBlocked ? 1603 : result, state.Message);
            }
            finally
            {
                IntPtr ignored;
                MsiSetExternalUIRecord(null, 0, IntPtr.Zero, out ignored);
                MsiEnableLog(0, null, 0);
                MsiSetInternalUI(previousLevel, ref owner);
                GC.KeepAlive(callback);
            }
        }

        private static uint MessageFilter()
        {
            return (1u << (Progress >> 24)) | (1u << (ActionStart >> 24)) | (1u << (ActionData >> 24)) |
                (1u << (FatalExit >> 24)) | (1u << (Error >> 24)) | (1u << (OutOfDiskSpace >> 24)) |
                (1u << (FilesInUse >> 24)) | (1u << (RestartManagerFilesInUse >> 24));
        }

        private sealed class MessageHandler
        {
            private readonly CancellationToken cancellation;
            private readonly IProgress<MsiProgress> progress;
            private bool cancellationSent;
            private int? lastReported;
            private bool reported;
            private bool copyingFiles;
            private bool backward;
            private bool executing;
            private long total;
            private long ticks;
            private int actionStep;
            public bool ResourceBlocked;
            public string Message;

            public MessageHandler(CancellationToken cancellation, IProgress<MsiProgress> progress)
            {
                this.cancellation = cancellation;
                this.progress = progress;
            }

            public int Handle(IntPtr context, uint messageType, uint record)
            {
                try
                {
                    var message = (int)(messageType & 0xff000000);
                    if (message == Error || message == FatalExit)
                    {
                        var detail = RecordText(record);
                        if (String.IsNullOrEmpty(Message) && !String.IsNullOrWhiteSpace(detail)) Message = detail;
                        return 0;
                    }
                    if (message == FilesInUse || message == RestartManagerFilesInUse || message == OutOfDiskSpace)
                    {
                        if (cancellationSent) return 0;
                        Message = message == OutOfDiskSpace ? "磁盘空间不足。请释放空间后重试。"
                            : "安装文件仍在使用中。请关闭 RiA 后重试。";
                        ResourceBlocked = !cancellation.IsCancellationRequested;
                        cancellationSent = true;
                        return IdCancel;
                    }
                    if (message == ActionStart)
                    {
                        var action = new StringBuilder(80);
                        uint length = (uint)action.Capacity;
                        copyingFiles = MsiRecordGetString(record, 1, action, ref length) == 0 && action.ToString() == "InstallFiles";
                        PublishProgress();
                        return 0;
                    }
                    if (message != Progress && message != ActionData) return 0;
                    if (message == Progress) ReadProgress(record);
                    else if (actionStep > 0 && total > 0) ticks += actionStep;

                    // Once Windows Installer has accepted cancellation, leave its
                    // remaining progress and rollback messages alone.
                    if (!cancellationSent && !backward && cancellation.IsCancellationRequested)
                    {
                        cancellationSent = true;
                        return IdCancel;
                    }
                    PublishProgress();
                    return IdOk;
                }
                catch
                {
                    // Never let a managed exception cross the native callback.
                    return 0;
                }
            }

            private void PublishProgress()
            {
                if (backward || cancellationSent || progress == null) return;
                // MSI resets the tick counter for planning and nested removals.
                // Show percentages only while the install script is copying files.
                int? percent = copyingFiles && executing && total > 0
                    ? (int?)Math.Min(99, Math.Max(0, ticks * 100 / total)) : null;
                if (reported && percent == lastReported) return;
                reported = true;
                lastReported = percent;
                progress.Report(new MsiProgress(percent));
            }

            private void ReadProgress(uint record)
            {
                var delta = Math.Max(0, MsiRecordGetInteger(record, 2));
                switch (MsiRecordGetInteger(record, 1))
                {
                    case 0:
                        total = delta;
                        ticks = 0;
                        actionStep = 0;
                        backward = MsiRecordGetInteger(record, 3) == 1;
                        executing = MsiRecordGetInteger(record, 4) == 0;
                        break;
                    case 1: actionStep = MsiRecordGetInteger(record, 3) == 1 ? delta : 0; break;
                    case 2: ticks += delta; break;
                    case 3: total += delta; break;
                }
            }
        }

        private static string RecordText(uint record)
        {
            if (record == 0) return null;
            var buffer = new StringBuilder(512);
            uint length = (uint)buffer.Capacity;
            var result = MsiFormatRecord(0, record, buffer, ref length);
            if (result == 234 && length < 8192)
            {
                buffer = new StringBuilder((int)length + 1);
                length = (uint)buffer.Capacity;
                result = MsiFormatRecord(0, record, buffer, ref length);
            }
            return result == 0 ? buffer.ToString() : null;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate int ExternalUi(IntPtr context, uint messageType, uint record);

        [DllImport("msi.dll", ExactSpelling = true)]
        private static extern uint MsiSetInternalUI(uint level, ref IntPtr owner);
        [DllImport("msi.dll", ExactSpelling = true)]
        private static extern uint MsiSetExternalUIRecord(ExternalUi handler, uint filter, IntPtr context, out IntPtr previousHandler);
        [DllImport("msi.dll", EntryPoint = "MsiInstallProductW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiInstallProduct(string path, string properties);
        [DllImport("msi.dll", EntryPoint = "MsiEnableLogW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiEnableLog(uint mode, string path, uint attributes);
        [DllImport("msi.dll", ExactSpelling = true)]
        private static extern int MsiRecordGetInteger(uint record, uint field);
        [DllImport("msi.dll", EntryPoint = "MsiRecordGetStringW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
        [DllImport("msi.dll", EntryPoint = "MsiFormatRecordW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiFormatRecord(uint install, uint record, StringBuilder value, ref uint length);
    }

    internal sealed class InstalledProduct
    {
        private const uint MachineContext = 4;
        public Version Version;
        public string Directory;

        public static InstalledProduct Find(string upgradeCode)
        {
            InstalledProduct installed = null;
            using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            {
                for (uint index = 0; ; index++)
                {
                    var productCode = new StringBuilder(39);
                    var result = MsiEnumRelatedProducts(upgradeCode, 0, index, productCode);
                    if (result == 259) return installed;
                    if (result != 0) throw new Win32Exception((int)result);
                    var versionText = new StringBuilder(32);
                    var size = (uint)versionText.Capacity;
                    result = MsiGetProductInfoEx(productCode.ToString(), null, MachineContext, "VersionString", versionText, ref size);
                    if (result == 1605) continue;
                    if (result != 0) throw new Win32Exception((int)result);
                    var version = new Version(versionText.ToString());
                    if (installed != null && installed.Version >= version) continue;
                    using (var key = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + productCode + ".msq"))
                        installed = new InstalledProduct { Version = version, Directory = key == null ? null : key.GetValue("InstallPath") as string };
                }
            }
        }

        [DllImport("msi.dll", EntryPoint = "MsiEnumRelatedProductsW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiEnumRelatedProducts(string upgradeCode, uint reserved, uint index, StringBuilder productCode);
        [DllImport("msi.dll", EntryPoint = "MsiGetProductInfoExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiGetProductInfoEx(string productCode, string sid, uint context, string property, StringBuilder value, ref uint length);
    }
}
