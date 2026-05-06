# JIANCHA Dashboard — Operations Runbook

## 🟢 สถานะ ณ launch (2026-04-30)

| Component | Status |
|---|---|
| Dashboard server | ✅ pid managed by launchd, KeepAlive=true |
| Sync schedule | ✅ ทุก 6 ชม. + jitter + shuffle |
| Watchdog cron | ✅ ทุก 5 นาที |
| Teams alerts | ✅ webhook verified |
| Backup ครั้งแรก | ✅ `backups/launch-20260430-142637.tar.gz` |
| Auth | ✅ 3 users with PBKDF2 hashed passwords |
| Audit log | ✅ `logs/audit.log` |

---

## ⚠️ สิ่งที่คุณต้องทำเอง (ภายใน 24 ชม.)

### 1. Mac sleep prevention (REQUIRED)
ถ้ายังไม่ได้รัน:
```bash
sudo pmset -a sleep 0 displaysleep 10 disksleep 0 powernap 1 womp 1
pmset -g | grep -E "sleep|displaysleep"   # verify
```

### 2. เปลี่ยน password 3 user (RECOMMENDED — ปัจจุบันอ่อน)
```bash
cd "/Users/guest1123/Grab - Menu"
open -a TextEdit scripts/init-users.py
# แก้ password 3 ตัว ให้แข็งแรง (≥12 ตัวอักษร + เลข + สัญลักษณ์)
python3 scripts/init-users.py
launchctl kickstart -k "gui/$(id -u)/com.jiancha.dashboard"
```

### 3. (ตัวเลือก) Cloudflare Tunnel — ทีม remote ใช้ได้
ดูคู่มือใน [PRODUCTION.md](PRODUCTION.md) section "🆓 HTTPS ฟรี"

---

## 🔍 Daily monitoring (5 นาที / วัน)

```bash
# 1. Server up?
curl -s http://localhost:8765/api/health | python3 -m json.tool

# 2. ใครเข้าระบบบ้าง?
tail -20 "/Users/guest1123/Grab - Menu/logs/audit.log"

# 3. มี account ที่ Grab ban มั้ย?
cat "/Users/guest1123/Grab - Menu/runner/logs/.account-fails.json" 2>/dev/null

# 4. Sync ทำงานปกติ?
tail -30 "/Users/guest1123/Grab - Menu/runner/logs/launchd.log"

# 5. Watchdog passing?
tail -10 "/Users/guest1123/Grab - Menu/logs/watchdog.log"
```

---

## 🚨 Trigger ให้รีบดู

| สัญญาณ | ทำยังไง |
|---|---|
| Teams card สีแดง | อ่านข้อความ → ทำตาม "Common alerts" ด้านล่าง |
| Account ถูก pause >5 ตัว | หยุด schedule + login Grab manual + เปลี่ยน password Grab |
| Login fail rate >30% | ตรวจ Grab portal ว่ายังเข้าได้ไหม / proxy IP โดน block |
| Server down >30 min | ตรวจ `logs/dashboard.err.log` → restart manual |
| Disk เต็ม (Mac) | ลบ `runner/logs/launchd.log` (rotate auto ได้) |

---

## 🔧 Common alerts จาก Watchdog

### "Dashboard server DOWN"
```bash
# Watchdog พยายาม restart ให้แล้ว ถ้ายัง down:
tail -50 "/Users/guest1123/Grab - Menu/logs/dashboard.err.log"
launchctl kickstart -k "gui/$(id -u)/com.jiancha.dashboard"
sleep 5
curl -s http://localhost:8765/api/health
```

### "Data stale — last sync Xmin ago"
```bash
# ตรวจ Chrome 9222 ยังเปิดอยู่มั้ย
curl -s http://localhost:9222/json/version

# Force sync ทันที
launchctl start com.jiancha.grab-sync
tail -f "/Users/guest1123/Grab - Menu/runner/logs/launchd.log"
```

### "Chrome debug port 9222 not responding"
- ตรวจว่า Chrome เปิดอยู่ + รัน `--remote-debugging-port=9222`
- หรือ start ใหม่:
```bash
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="/tmp/chrome-debug"
```

### "X accounts paused"
```bash
# ดูว่าบัญชีไหน
cat "/Users/guest1123/Grab - Menu/runner/logs/.account-fails.json"

# ลอง login Grab manual ก่อน
# ถ้า login ผ่าน → reset fail counter
echo '{}' > "/Users/guest1123/Grab - Menu/runner/logs/.account-fails.json"
```

---

## 📦 Backup (ทุกสัปดาห์)

```bash
cd "/Users/guest1123/Grab - Menu"
DATE=$(date +%Y%m%d)
tar czf "backups/weekly-$DATE.tar.gz" \
  vault.enc users.json server-data.json \
  scripts/watchdog.env scripts/init-users.py logs/audit.log

# ลบ backup เก่ากว่า 60 วัน
find backups -name "*.tar.gz" -mtime +60 -delete
```

(ตั้ง cron ทุกวันอาทิตย์ตี 1 ก็ได้):
```bash
crontab -e
# เพิ่ม:
0 1 * * 0 cd "/Users/guest1123/Grab - Menu" && tar czf "backups/weekly-$(date +%Y%m%d).tar.gz" vault.enc users.json server-data.json scripts/watchdog.env scripts/init-users.py logs/audit.log 2>/dev/null
```

---

## 🛑 Emergency rollback

```bash
# 1. หยุดทุกอย่าง
launchctl unload ~/Library/LaunchAgents/com.jiancha.dashboard.plist
launchctl unload ~/Library/LaunchAgents/com.jiancha.grab-sync.plist
crontab -l | grep -v watchdog | crontab -

# 2. กู้จาก backup
cd "/Users/guest1123/Grab - Menu"
tar xzf backups/launch-20260430-142637.tar.gz

# 3. (ถ้า code มีปัญหา) git revert
git log --oneline -5
git revert HEAD     # หรือ checkout commit เก่า
```

---

## 📞 ติดต่อช่วยเหลือ

- IT Admin: admin@jianchatea.com
- Repo: https://github.com/itjianchacenter-ai/Grab-Menu
- Docs: [PRODUCTION.md](PRODUCTION.md) · [RUNBOOK.md](RUNBOOK.md) (this file)

---

## 🎯 Success metrics (ติดตาม 30 วันแรก)

- [ ] Server uptime > 99% (ไม่ down เกิน 7 ชม./เดือน)
- [ ] Sync success rate > 90% (40+ จาก 48 สาขาดึงสำเร็จทุกรอบ)
- [ ] Account pause rate < 5% (≤ 2 บัญชีถูก pause / สัปดาห์)
- [ ] User login เป็นประจำ (เห็นใน audit log ทุกวัน)
- [ ] ไม่มี security alert (ไม่มี login_blocked_rate_limit จาก IP แปลก)
