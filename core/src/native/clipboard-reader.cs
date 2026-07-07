using System;
using System.Windows.Forms;
using System.Threading;

class ClipboardReader {
    [STAThread]
    static void Main(string[] args) {
        string text = "";
        var t = new Thread(() => {
            try {
                text = Clipboard.GetText();
            } catch { }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        if (!t.Join(2000)) {
            t.Abort();
        }
        Console.Write(text ?? "");
    }
}