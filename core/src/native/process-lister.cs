using System;
using System.Diagnostics;
using System.Management;
using System.Text;

class ProcessLister {
    static void Main() {
        try {
            var sb = new StringBuilder();
            sb.Append("[");
            bool first = true;
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process " +
                "WHERE Name = 'QQ.exe' OR Name = 'QQEX.exe' OR Name = 'crashpad_handler.exe'"))
            {
                foreach (ManagementObject obj in searcher.Get()) {
                    if (!first) sb.Append(",");
                    first = false;
                    int pid = Convert.ToInt32(obj["ProcessId"]);
                    int ppid = Convert.ToInt32(obj["ParentProcessId"]);
                    string name = Convert.ToString(obj["Name"]) ?? "";
                    string cmd = (Convert.ToString(obj["CommandLine"]) ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
                    string ctime = Convert.ToString(obj["CreationDate"]) ?? "";
                    sb.Append("{\"pid\":").Append(pid)
                      .Append(",\"name\":\"").Append(Escape(name))
                      .Append("\",\"parentPid\":").Append(ppid)
                      .Append(",\"commandLine\":\"").Append(Escape(cmd))
                      .Append("\",\"createdAt\":\"").Append(Escape(ctime))
                      .Append("\"}");
                }
            }
            sb.Append("]");
            Console.WriteLine(sb.ToString());
        } catch {
            Console.WriteLine("[]");
        }
    }
    static string Escape(string s) {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
    }
}
