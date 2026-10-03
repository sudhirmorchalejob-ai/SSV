// SSVAgentService - runs ssv-agent.exe as a Windows service.
//
// Built with the C# compiler that ships with .NET Framework 4 (csc.exe), so no
// third-party service wrapper is downloaded. The service:
//   * starts ssv-agent.exe (same folder) hidden, with the working directory set to
//     the config folder, so the agent reads the .env kept there;
//   * sets DATA_DIR to <config>\data unless that .env sets its own;
//   * restarts the agent if it exits (10 s, doubling to at most 5 min);
//   * writes the agent's output to <config>\logs\agent.log, rotated at 10 MB.
// Config folder: C:\ProgramData\SSVConnector (or SSV_CONFIG_DIR).
//
//   SSVAgentService.exe --console [seconds]   run in this window until Enter is pressed,
//                                             or for that many seconds (testing)

using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading;

public class SSVAgentService : ServiceBase
{
    public const string Name = "SSVAgent";
    const long MaxLogBytes = 10 * 1024 * 1024;

    readonly string exeDir = AppDomain.CurrentDomain.BaseDirectory;
    readonly string configDir;
    readonly string logDir;
    readonly object logLock = new object();
    Process agent;
    Thread supervisor;
    volatile bool stopping;

    public SSVAgentService()
    {
        ServiceName = Name;
        CanStop = true;
        CanShutdown = true;
        configDir = Environment.GetEnvironmentVariable("SSV_CONFIG_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SSVConnector");
        logDir = Path.Combine(configDir, "logs");
    }

    public static void Main(string[] args)
    {
        var svc = new SSVAgentService();
        if (args.Length > 0 && args[0] == "--console")
        {
            svc.OnStart(args);
            int seconds;
            if (args.Length > 1 && int.TryParse(args[1], out seconds))
            {
                Console.WriteLine("SSV agent running for " + seconds + " s (log: " + Path.Combine(svc.logDir, "agent.log") + ")");
                Thread.Sleep(seconds * 1000);
            }
            else
            {
                Console.WriteLine("SSV agent running (log: " + Path.Combine(svc.logDir, "agent.log") + "). Press Enter to stop.");
                Console.ReadLine();
            }
            svc.OnStop();
            return;
        }
        ServiceBase.Run(svc);
    }

    protected override void OnStart(string[] args)
    {
        Directory.CreateDirectory(logDir);
        stopping = false;
        supervisor = new Thread(Supervise) { IsBackground = true, Name = "ssv-supervisor" };
        supervisor.Start();
    }

    protected override void OnStop() { Shutdown(); }
    protected override void OnShutdown() { Shutdown(); }

    void Shutdown()
    {
        stopping = true;
        try
        {
            var p = agent;
            if (p != null && !p.HasExited)
            {
                p.Kill();
                p.WaitForExit(10000);
            }
        }
        catch (Exception e) { Log("service: stopping the agent failed: " + e.Message); }
        Log("service: stopped");
    }

    const int UpdateExitCode = 75;      // the agent staged an approved update and wants it installed
    const int RestartExitCode = 76;     // settings were changed on the setup page: start again at once
    string justInstalled;               // version installed by this service, until it has proved itself
    int quickFailuresSinceInstall;

    void Supervise()
    {
        int delay = 10;
        while (!stopping)
        {
            var started = DateTime.UtcNow;
            int code = -1;
            try
            {
                code = RunAgentOnce();
            }
            catch (Exception e)
            {
                Log("service: could not start ssv-agent.exe: " + e.Message);
            }
            if (stopping) break;
            bool quick = (DateTime.UtcNow - started).TotalSeconds < 120;
            if (code == UpdateExitCode && InstallUpdate())
            {
                continue; // start the new version straight away
            }
            if (code == RestartExitCode)
            {
                Log("service: settings changed; restarting the agent");
                continue; // a deliberate restart, not a failure
            }
            if (justInstalled != null)
            {
                if (!quick) justInstalled = null; // the new version ran properly: keep it
                else if (++quickFailuresSinceInstall >= 3)
                {
                    RollBack();
                    delay = 5; // the previous version is known to work: restart it promptly
                }
            }
            // A run that lasted a while resets the back-off; quick crashes double it.
            delay = (DateTime.UtcNow - started).TotalMinutes > 10 ? 10 : Math.Min(delay * 2, 300);
            Log("service: agent exited; restarting in " + delay + " s");
            for (int i = 0; i < delay * 10 && !stopping; i++) Thread.Sleep(100);
        }
    }

    string UpdateDir { get { return Path.Combine(configDir, "update"); } }

    /// Put the staged, checksum-verified exe in place; keep the current one as ssv-agent.exe.old.
    bool InstallUpdate()
    {
        var manifest = Path.Combine(UpdateDir, "update.json");
        var staged = Path.Combine(UpdateDir, "ssv-agent.exe");
        try
        {
            if (!File.Exists(manifest) || !File.Exists(staged)) return false;
            var json = File.ReadAllText(manifest);
            var version = Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
            var want = Regex.Match(json, "\"sha256\"\\s*:\\s*\"([0-9a-fA-F]{64})\"").Groups[1].Value.ToLowerInvariant();
            string got;
            using (var sha = SHA256.Create())
            using (var f = File.OpenRead(staged))
                got = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
            if (version.Length == 0 || got != want)
            {
                Log("service: staged update does not match its checksum; not installed");
                File.Delete(staged);
                File.Delete(manifest);
                return false;
            }
            var target = Path.Combine(exeDir, "ssv-agent.exe");
            var old = Path.Combine(exeDir, "ssv-agent.exe.old");
            File.Copy(target, old, true);
            File.Copy(staged, target, true);
            File.Delete(staged);
            File.Delete(manifest);
            justInstalled = version;
            quickFailuresSinceInstall = 0;
            Log("service: installed agent " + version + " (previous kept as ssv-agent.exe.old)");
            return true;
        }
        catch (Exception e)
        {
            Log("service: installing the update failed: " + e.Message);
            return false;
        }
    }

    /// The new version keeps failing: put the previous exe back and never try that version again.
    void RollBack()
    {
        try
        {
            var target = Path.Combine(exeDir, "ssv-agent.exe");
            var old = Path.Combine(exeDir, "ssv-agent.exe.old");
            if (!File.Exists(old)) return;
            File.Copy(old, target, true);
            Directory.CreateDirectory(UpdateDir);
            File.WriteAllText(Path.Combine(UpdateDir, "bad-" + justInstalled), DateTime.UtcNow.ToString("o"));
            Log("service: agent " + justInstalled + " kept failing; previous version restored");
        }
        catch (Exception e)
        {
            Log("service: rollback failed: " + e.Message);
        }
        finally
        {
            justInstalled = null;
        }
    }

    int RunAgentOnce()
    {
        var psi = new ProcessStartInfo(Path.Combine(exeDir, "ssv-agent.exe"))
        {
            WorkingDirectory = configDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (!EnvFileSets("DATA_DIR"))
            psi.EnvironmentVariables["DATA_DIR"] = Path.Combine(configDir, "data");
        psi.EnvironmentVariables["SSV_SERVICE"] = "1"; // lets the agent stage approved updates
        agent = new Process { StartInfo = psi };
        agent.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        agent.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
        agent.Start();
        Log("service: started ssv-agent.exe (pid " + agent.Id + ")");
        agent.BeginOutputReadLine();
        agent.BeginErrorReadLine();
        agent.WaitForExit();
        Log("service: ssv-agent.exe exited with code " + agent.ExitCode);
        return agent.ExitCode;
    }

    bool EnvFileSets(string key)
    {
        try
        {
            foreach (var line in File.ReadAllLines(Path.Combine(configDir, ".env")))
                if (line.TrimStart().StartsWith(key + "=")) return true;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return false;
    }

    void Log(string line)
    {
        lock (logLock)
        {
            try
            {
                Directory.CreateDirectory(logDir);
                var file = Path.Combine(logDir, "agent.log");
                if (File.Exists(file) && new FileInfo(file).Length > MaxLogBytes)
                {
                    var old = Path.Combine(logDir, "agent.1.log");
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(file, old);
                }
                File.AppendAllText(file, (line.Length > 0 && char.IsDigit(line[0]) ? "" : DateTime.UtcNow.ToString("o") + " ") + line + Environment.NewLine);
            }
            catch { /* logging must never stop the service */ }
        }
    }
}
