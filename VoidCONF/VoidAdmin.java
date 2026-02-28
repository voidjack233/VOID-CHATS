import javax.swing.*;
import javax.swing.border.*;
import java.awt.*;
import java.awt.event.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public class VoidAdmin extends JFrame {

    // Dark theme colors
    static final Color BG_DARK = new Color(18, 18, 24);
    static final Color BG_CARD = new Color(30, 30, 42);
    static final Color BG_CARD_HOVER = new Color(38, 38, 52);
    static final Color ACCENT_PURPLE = new Color(124, 92, 252);
    static final Color ACCENT_GREEN = new Color(46, 204, 113);
    static final Color ACCENT_RED = new Color(231, 76, 60);
    static final Color ACCENT_YELLOW = new Color(241, 196, 15);
    static final Color ACCENT_BLUE = new Color(52, 152, 219);
    static final Color TEXT_PRIMARY = new Color(230, 230, 240);
    static final Color TEXT_SECONDARY = new Color(140, 140, 160);
    static final Color BORDER_COLOR = new Color(50, 50, 65);

    // Services
    static final String[][] SERVICES = {
        {"nginx", "Nginx", "Web Server"},
        {"voidapp-backend", "Backend API", "Node.js Express"},
        {"minio", "MinIO", "Object Storage"},
        {"cloudflared", "Cloudflared", "CF Tunnel"},
        {"valkey-server", "Valkey", "Cache / Sessions"},
    };

    private final Map<String, ServicePanel> servicePanels = new LinkedHashMap<>();
    private StatsPanel statsPanel;
    private ValkeyStatsPanel valkeyStatsPanel;
    private JLabel uptimeLabel;
    private ScheduledExecutorService scheduler;

    public VoidAdmin() {
        setTitle("VOID Admin Dashboard");
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setSize(1000, 800);
        setMinimumSize(new Dimension(850, 700));
        setLocationRelativeTo(null);
        getContentPane().setBackground(BG_DARK);
        setLayout(new BorderLayout(0, 0));

        // Header
        add(createHeader(), BorderLayout.NORTH);

        // Main content
        JPanel content = new JPanel(new BorderLayout(12, 12));
        content.setBackground(BG_DARK);
        content.setBorder(BorderFactory.createEmptyBorder(12, 16, 16, 16));

        // Services grid
        JPanel servicesGrid = new JPanel(new GridLayout(2, 3, 12, 12));
        servicesGrid.setBackground(BG_DARK);

        for (String[] svc : SERVICES) {
            ServicePanel panel = new ServicePanel(svc[0], svc[1], svc[2]);
            servicePanels.put(svc[0], panel);
            servicesGrid.add(panel);
        }

        // Valkey stats panel in the 6th slot
        valkeyStatsPanel = new ValkeyStatsPanel();
        servicesGrid.add(valkeyStatsPanel);

        content.add(servicesGrid, BorderLayout.CENTER);

        // System stats at bottom
        statsPanel = new StatsPanel();
        content.add(statsPanel, BorderLayout.SOUTH);

        add(content, BorderLayout.CENTER);

        // Footer
        add(createFooter(), BorderLayout.SOUTH);

        // Start auto-refresh
        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "admin-refresh");
            t.setDaemon(true);
            return t;
        });
        scheduler.scheduleAtFixedRate(this::refreshAll, 0, 3, TimeUnit.SECONDS);

        addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                scheduler.shutdownNow();
            }
        });
    }

    private JPanel createHeader() {
        JPanel header = new JPanel(new BorderLayout());
        header.setBackground(BG_CARD);
        header.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, BORDER_COLOR),
            BorderFactory.createEmptyBorder(14, 20, 14, 20)
        ));

        JLabel title = new JLabel("⚡ VOID Admin Dashboard");
        title.setFont(new Font("SansSerif", Font.BOLD, 20));
        title.setForeground(TEXT_PRIMARY);
        header.add(title, BorderLayout.WEST);

        // Refresh all button
        JButton refreshBtn = createStyledButton("↻ Refresh All", ACCENT_BLUE);
        refreshBtn.addActionListener(e -> refreshAll());
        
        JPanel rightPanel = new JPanel(new FlowLayout(FlowLayout.RIGHT, 8, 0));
        rightPanel.setBackground(BG_CARD);
        
        // Restart all button
        JButton restartAllBtn = createStyledButton("⟳ Restart All", ACCENT_PURPLE);
        restartAllBtn.addActionListener(e -> {
            int confirm = JOptionPane.showConfirmDialog(this,
                "Restart all services?", "Confirm", JOptionPane.YES_NO_OPTION);
            if (confirm == JOptionPane.YES_OPTION) {
                for (String[] svc : SERVICES) {
                    runServiceAction(svc[0], "restart");
                }
            }
        });

        rightPanel.add(refreshBtn);
        rightPanel.add(restartAllBtn);
        header.add(rightPanel, BorderLayout.EAST);

        return header;
    }

    private JPanel createFooter() {
        JPanel footer = new JPanel(new BorderLayout());
        footer.setBackground(BG_CARD);
        footer.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(1, 0, 0, 0, BORDER_COLOR),
            BorderFactory.createEmptyBorder(8, 20, 8, 20)
        ));

        uptimeLabel = new JLabel("System uptime: loading...");
        uptimeLabel.setFont(new Font("SansSerif", Font.PLAIN, 12));
        uptimeLabel.setForeground(TEXT_SECONDARY);
        footer.add(uptimeLabel, BorderLayout.WEST);

        JLabel versionLabel = new JLabel("VOIDAPP Admin v1.0");
        versionLabel.setFont(new Font("SansSerif", Font.PLAIN, 12));
        versionLabel.setForeground(TEXT_SECONDARY);
        footer.add(versionLabel, BorderLayout.EAST);

        return footer;
    }

    // ─── Service Panel ───────────────────────────────────────────────────

    class ServicePanel extends JPanel {
        String serviceName;
        JLabel statusDot;
        JLabel statusText;
        JLabel uptimeText;
        JButton startBtn, stopBtn, restartBtn;
        JTextArea logArea;

        ServicePanel(String serviceName, String displayName, String description) {
            this.serviceName = serviceName;
            setBackground(BG_CARD);
            setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BORDER_COLOR, 1, true),
                BorderFactory.createEmptyBorder(14, 16, 14, 16)
            ));
            setLayout(new BorderLayout(0, 8));

            // Top: name + status
            JPanel top = new JPanel(new BorderLayout());
            top.setBackground(BG_CARD);

            JPanel namePanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
            namePanel.setBackground(BG_CARD);

            statusDot = new JLabel("●");
            statusDot.setFont(new Font("SansSerif", Font.PLAIN, 14));
            statusDot.setForeground(TEXT_SECONDARY);

            JLabel nameLabel = new JLabel(displayName);
            nameLabel.setFont(new Font("SansSerif", Font.BOLD, 15));
            nameLabel.setForeground(TEXT_PRIMARY);

            namePanel.add(statusDot);
            namePanel.add(nameLabel);
            top.add(namePanel, BorderLayout.WEST);

            statusText = new JLabel("checking...");
            statusText.setFont(new Font("Monospaced", Font.PLAIN, 11));
            statusText.setForeground(TEXT_SECONDARY);
            top.add(statusText, BorderLayout.EAST);

            add(top, BorderLayout.NORTH);

            // Center: description + uptime + logs
            JPanel center = new JPanel();
            center.setLayout(new BoxLayout(center, BoxLayout.Y_AXIS));
            center.setBackground(BG_CARD);

            JLabel descLabel = new JLabel(description);
            descLabel.setFont(new Font("SansSerif", Font.PLAIN, 12));
            descLabel.setForeground(TEXT_SECONDARY);
            descLabel.setAlignmentX(LEFT_ALIGNMENT);
            center.add(descLabel);
            center.add(Box.createVerticalStrut(4));

            uptimeText = new JLabel("Uptime: --");
            uptimeText.setFont(new Font("Monospaced", Font.PLAIN, 11));
            uptimeText.setForeground(TEXT_SECONDARY);
            uptimeText.setAlignmentX(LEFT_ALIGNMENT);
            center.add(uptimeText);
            center.add(Box.createVerticalStrut(6));

            // Log area
            logArea = new JTextArea(3, 20);
            logArea.setBackground(BG_DARK);
            logArea.setForeground(TEXT_SECONDARY);
            logArea.setFont(new Font("Monospaced", Font.PLAIN, 10));
            logArea.setEditable(false);
            logArea.setLineWrap(true);
            logArea.setWrapStyleWord(true);
            logArea.setBorder(BorderFactory.createEmptyBorder(4, 6, 4, 6));

            JScrollPane logScroll = new JScrollPane(logArea);
            logScroll.setAlignmentX(LEFT_ALIGNMENT);
            logScroll.setBorder(BorderFactory.createLineBorder(BORDER_COLOR));
            logScroll.setPreferredSize(new Dimension(0, 60));
            center.add(logScroll);

            add(center, BorderLayout.CENTER);

            // Bottom: buttons
            JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
            buttons.setBackground(BG_CARD);

            startBtn = createStyledButton("▶ Start", ACCENT_GREEN);
            stopBtn = createStyledButton("■ Stop", ACCENT_RED);
            restartBtn = createStyledButton("⟳ Restart", ACCENT_YELLOW);

            startBtn.addActionListener(e -> runServiceAction(serviceName, "start"));
            stopBtn.addActionListener(e -> runServiceAction(serviceName, "stop"));
            restartBtn.addActionListener(e -> runServiceAction(serviceName, "restart"));

            buttons.add(startBtn);
            buttons.add(stopBtn);
            buttons.add(restartBtn);
            add(buttons, BorderLayout.SOUTH);
        }

        void updateStatus(boolean running, String statusStr, String uptime, String logs) {
            SwingUtilities.invokeLater(() -> {
                statusDot.setForeground(running ? ACCENT_GREEN : ACCENT_RED);
                statusText.setText(running ? "● running" : "○ stopped");
                statusText.setForeground(running ? ACCENT_GREEN : ACCENT_RED);
                uptimeText.setText("Uptime: " + uptime);
                startBtn.setEnabled(!running);
                stopBtn.setEnabled(running);
                restartBtn.setEnabled(running);
                logArea.setText(logs);
                logArea.setCaretPosition(logArea.getDocument().getLength());
            });
        }
    }

    // ─── System Stats Panel ──────────────────────────────────────────────

    class StatsPanel extends JPanel {
        JProgressBar cpuBar, ramBar, diskBar;
        JLabel cpuLabel, ramLabel, diskLabel;

        StatsPanel() {
            setBackground(BG_CARD);
            setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BORDER_COLOR, 1, true),
                BorderFactory.createEmptyBorder(14, 16, 14, 16)
            ));
            setLayout(new BorderLayout(0, 10));

            JLabel title = new JLabel("📊 System Resources");
            title.setFont(new Font("SansSerif", Font.BOLD, 14));
            title.setForeground(TEXT_PRIMARY);
            add(title, BorderLayout.NORTH);

            JPanel bars = new JPanel(new GridLayout(3, 1, 0, 8));
            bars.setBackground(BG_CARD);

            cpuBar = createStatBar();
            ramBar = createStatBar();
            diskBar = createStatBar();
            cpuLabel = new JLabel("CPU: --");
            ramLabel = new JLabel("RAM: --");
            diskLabel = new JLabel("Disk: --");

            bars.add(createStatRow("CPU", cpuBar, cpuLabel));
            bars.add(createStatRow("RAM", ramBar, ramLabel));
            bars.add(createStatRow("DISK", diskBar, diskLabel));

            add(bars, BorderLayout.CENTER);
        }

        JProgressBar createStatBar() {
            JProgressBar bar = new JProgressBar(0, 100);
            bar.setStringPainted(false);
            bar.setPreferredSize(new Dimension(0, 18));
            bar.setBackground(BG_DARK);
            bar.setForeground(ACCENT_PURPLE);
            bar.setBorderPainted(false);
            return bar;
        }

        JPanel createStatRow(String name, JProgressBar bar, JLabel detail) {
            JPanel row = new JPanel(new BorderLayout(10, 0));
            row.setBackground(BG_CARD);

            JLabel label = new JLabel(name);
            label.setFont(new Font("Monospaced", Font.BOLD, 12));
            label.setForeground(TEXT_PRIMARY);
            label.setPreferredSize(new Dimension(45, 18));

            detail.setFont(new Font("Monospaced", Font.PLAIN, 11));
            detail.setForeground(TEXT_SECONDARY);
            detail.setPreferredSize(new Dimension(220, 18));

            row.add(label, BorderLayout.WEST);
            row.add(bar, BorderLayout.CENTER);
            row.add(detail, BorderLayout.EAST);

            return row;
        }

        void update(int cpuPct, String cpuInfo, int ramPct, String ramInfo, int diskPct, String diskInfo) {
            SwingUtilities.invokeLater(() -> {
                cpuBar.setValue(cpuPct);
                cpuBar.setForeground(getBarColor(cpuPct));
                cpuLabel.setText(cpuInfo);

                ramBar.setValue(ramPct);
                ramBar.setForeground(getBarColor(ramPct));
                ramLabel.setText(ramInfo);

                diskBar.setValue(diskPct);
                diskBar.setForeground(getBarColor(diskPct));
                diskLabel.setText(diskInfo);
            });
        }

        Color getBarColor(int pct) {
            if (pct < 60) return ACCENT_GREEN;
            if (pct < 80) return ACCENT_YELLOW;
            return ACCENT_RED;
        }
    }

    // ─── Valkey Stats Panel ─────────────────────────────────────────────

    class ValkeyStatsPanel extends JPanel {
        JLabel keysLabel, memoryLabel, hitsLabel, uptimeLabel2;

        ValkeyStatsPanel() {
            setBackground(BG_CARD);
            setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BORDER_COLOR, 1, true),
                BorderFactory.createEmptyBorder(14, 16, 14, 16)
            ));
            setLayout(new BorderLayout(0, 8));

            // Top
            JPanel top = new JPanel(new BorderLayout());
            top.setBackground(BG_CARD);

            JPanel namePanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
            namePanel.setBackground(BG_CARD);

            JLabel dot = new JLabel("📊");
            dot.setFont(new Font("SansSerif", Font.PLAIN, 14));

            JLabel nameLabel = new JLabel("Valkey Stats");
            nameLabel.setFont(new Font("SansSerif", Font.BOLD, 15));
            nameLabel.setForeground(TEXT_PRIMARY);

            namePanel.add(dot);
            namePanel.add(nameLabel);
            top.add(namePanel, BorderLayout.WEST);
            add(top, BorderLayout.NORTH);

            // Center: stats
            JPanel center = new JPanel();
            center.setLayout(new BoxLayout(center, BoxLayout.Y_AXIS));
            center.setBackground(BG_CARD);

            keysLabel = createStatLabel("Keys: --");
            memoryLabel = createStatLabel("Memory: --");
            hitsLabel = createStatLabel("Hit rate: --");
            uptimeLabel2 = createStatLabel("Uptime: --");

            center.add(keysLabel);
            center.add(Box.createVerticalStrut(4));
            center.add(memoryLabel);
            center.add(Box.createVerticalStrut(4));
            center.add(hitsLabel);
            center.add(Box.createVerticalStrut(4));
            center.add(uptimeLabel2);
            center.add(Box.createVerticalStrut(6));

            // Flush button
            JButton flushBtn = createStyledButton("🗑 Flush All", ACCENT_RED);
            flushBtn.addActionListener(e -> {
                int confirm = JOptionPane.showConfirmDialog(
                    VoidAdmin.this,
                    "Flush all Valkey data? This clears rate limits, sessions, and cache.",
                    "Confirm Flush",
                    JOptionPane.YES_NO_OPTION
                );
                if (confirm == JOptionPane.YES_OPTION) {
                    exec("valkey-cli", "FLUSHALL");
                    refreshValkeyStats();
                }
            });
            JPanel btnPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
            btnPanel.setBackground(BG_CARD);
            btnPanel.add(flushBtn);

            center.add(btnPanel);
            add(center, BorderLayout.CENTER);
        }

        JLabel createStatLabel(String text) {
            JLabel label = new JLabel(text);
            label.setFont(new Font("Monospaced", Font.PLAIN, 11));
            label.setForeground(TEXT_SECONDARY);
            label.setAlignmentX(LEFT_ALIGNMENT);
            return label;
        }

        void update(String keys, String memory, String hitRate, String uptime) {
            SwingUtilities.invokeLater(() -> {
                keysLabel.setText("Keys: " + keys);
                memoryLabel.setText("Memory: " + memory);
                hitsLabel.setText("Hit rate: " + hitRate);
                uptimeLabel2.setText("Uptime: " + uptime);
            });
        }
    }

    void refreshValkeyStats() {
        try {
            String keys = exec("valkey-cli", "DBSIZE");
            keys = keys.replace("# Keyspace", "").replaceAll("[^0-9]", "").trim();
            if (keys.isEmpty()) keys = "0";

            String memRaw = exec("valkey-cli", "INFO", "memory");
            String memory = "unknown";
            for (String line : memRaw.split("\n")) {
                if (line.startsWith("used_memory_human:")) {
                    memory = line.split(":")[1].trim();
                    break;
                }
            }

            String statsRaw = exec("valkey-cli", "INFO", "stats");
            String hitRate = "N/A";
            long hits = 0, misses = 0;
            for (String line : statsRaw.split("\n")) {
                if (line.startsWith("keyspace_hits:")) hits = Long.parseLong(line.split(":")[1].trim());
                if (line.startsWith("keyspace_misses:")) misses = Long.parseLong(line.split(":")[1].trim());
            }
            if (hits + misses > 0) {
                hitRate = String.format("%.1f%% (%d/%d)", (hits * 100.0) / (hits + misses), hits, hits + misses);
            }

            String serverRaw = exec("valkey-cli", "INFO", "server");
            String uptime = "unknown";
            for (String line : serverRaw.split("\n")) {
                if (line.startsWith("uptime_in_seconds:")) {
                    long secs = Long.parseLong(line.split(":")[1].trim());
                    long days = secs / 86400;
                    long hours = (secs % 86400) / 3600;
                    long mins = (secs % 3600) / 60;
                    uptime = String.format("%dd %dh %dm", days, hours, mins);
                    break;
                }
            }

            valkeyStatsPanel.update(keys, memory, hitRate, uptime);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    // ─── Utility Methods ─────────────────────────────────────────────────

    static JButton createStyledButton(String text, Color color) {
        JButton btn = new JButton(text) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                if (getModel().isPressed()) {
                    g2.setColor(color.darker());
                } else if (getModel().isRollover()) {
                    g2.setColor(color.brighter());
                } else {
                    g2.setColor(color);
                }
                g2.fillRoundRect(0, 0, getWidth(), getHeight(), 8, 8);
                g2.dispose();
                super.paintComponent(g);
            }
        };
        btn.setFont(new Font("SansSerif", Font.BOLD, 11));
        btn.setForeground(Color.WHITE);
        btn.setContentAreaFilled(false);
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        btn.setPreferredSize(new Dimension(90, 28));
        return btn;
    }

    static String exec(String... cmd) {
        try {
            Process p = new ProcessBuilder(cmd)
                .redirectErrorStream(true)
                .start();
            String out = new String(p.getInputStream().readAllBytes()).trim();
            p.waitFor(5, TimeUnit.SECONDS);
            return out;
        } catch (Exception e) {
            return "error: " + e.getMessage();
        }
    }

    void runServiceAction(String service, String action) {
        new Thread(() -> {
            String result = exec("sudo", "systemctl", action, service);
            try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            refreshServiceStatus(service);
        }, "svc-" + action + "-" + service).start();
    }

    void refreshServiceStatus(String service) {
        ServicePanel panel = servicePanels.get(service);
        if (panel == null) return;

        String status = exec("systemctl", "is-active", service);
        boolean running = "active".equals(status);

        String uptime = "--";
        if (running) {
            String prop = exec("systemctl", "show", service, "--property=ActiveEnterTimestamp", "--value");
            if (prop != null && !prop.isEmpty() && !prop.startsWith("error")) {
                uptime = prop;
            }
        }

        String logs = exec("journalctl", "-u", service, "-n", "4", "--no-pager", "-o", "short-iso");

        panel.updateStatus(running, status, uptime, logs);
    }

    void refreshSystemStats() {
        try {
            // CPU - use /proc/stat
            String cpuLine = exec("bash", "-c",
                "top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
            int cpuPct = 0;
            try { cpuPct = (int) Math.round(Double.parseDouble(cpuLine)); } catch (Exception ignored) {}
            String cpuInfo = cpuPct + "% used";

            // RAM
            String memInfo = exec("bash", "-c",
                "free -m | awk '/Mem:/ {printf \"%d %d %d\", $2, $3, $7}'");
            String[] memParts = memInfo.split("\\s+");
            int totalMem = 0, usedMem = 0, availMem = 0;
            if (memParts.length >= 3) {
                totalMem = Integer.parseInt(memParts[0]);
                usedMem = Integer.parseInt(memParts[1]);
                availMem = Integer.parseInt(memParts[2]);
            }
            int ramPct = totalMem > 0 ? (usedMem * 100 / totalMem) : 0;
            String ramInfo = String.format("%dMB / %dMB (%dMB free)", usedMem, totalMem, availMem);

            // Disk
            String diskInfo = exec("bash", "-c",
                "df -h / | awk 'NR==2 {printf \"%s %s %s %s\", $2, $3, $4, $5}'");
            String[] diskParts = diskInfo.split("\\s+");
            int diskPct = 0;
            String diskStr = diskInfo;
            if (diskParts.length >= 4) {
                try { diskPct = Integer.parseInt(diskParts[3].replace("%", "")); } catch (Exception ignored) {}
                diskStr = String.format("%s / %s (%s free)", diskParts[1], diskParts[0], diskParts[2]);
            }

            statsPanel.update(cpuPct, cpuInfo, ramPct, ramInfo, diskPct, diskStr);

            // System uptime
            String uptime = exec("uptime", "-p");
            SwingUtilities.invokeLater(() -> uptimeLabel.setText("System " + uptime));

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    void refreshAll() {
        for (String[] svc : SERVICES) {
            refreshServiceStatus(svc[0]);
        }
        refreshSystemStats();
        refreshValkeyStats();
    }

    // ─── Main ────────────────────────────────────────────────────────────

    public static void main(String[] args) {
        // Set system look and feel tweaks
        System.setProperty("awt.useSystemAAFontSettings", "on");
        System.setProperty("swing.aatext", "true");

        SwingUtilities.invokeLater(() -> {
            VoidAdmin app = new VoidAdmin();
            app.setVisible(true);
        });
    }
}