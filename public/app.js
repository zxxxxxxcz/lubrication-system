(() => {
  const $ = (id) => document.getElementById(id);
  const pathMatch = location.pathname.match(/^\/e\/([^/?#]+)/i);
  const queryDevice = new URLSearchParams(location.search).get("device");
  let currentCode = decodeURIComponent(pathMatch?.[1] || queryDevice || "SB001").toUpperCase();
  let currentDevice = null;

  // 设备照片：把现场照片放到 public/images/，并按下面文件名命名即可。
  const DEVICE_IMAGES = {
    SB001: "/images/SB001.jpg",
    SB002: "/images/SB002.jpg",
    SB003: "/images/SB003.jpg",
    SB004: "/images/SB004.jpg",
    SB005: "/images/SB005.jpg"
  };

  function renderDevicePhoto(device) {
    const img = $("devicePhoto");
    const empty = $("devicePhotoEmpty");
    const caption = $("devicePhotoCaption");
    const src = DEVICE_IMAGES[device.code];

    img.hidden = true;
    empty.style.display = "flex";
    caption.textContent = `${device.code} · ${device.name}`;

    if (!src) return;

    img.alt = `${device.code} ${device.name} 设备照片`;
    img.onload = () => {
      img.hidden = false;
      empty.style.display = "none";
    };
    img.onerror = () => {
      img.hidden = true;
      empty.style.display = "flex";
    };
    img.src = `${src}?v=1`;
  }

  function fmtTime(value) {
    if (!value) return "暂无";
    const d = new Date(value);
    return new Intl.DateTimeFormat("zh-CN", {
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit",
      hour12:false
    }).format(d).replace(/\//g, "-");
  }

  function fmtAmount(v) {
    if (v === null || v === undefined) return "暂无";
    return `${Number(v).toFixed(3).replace(/\.?0+$/, "")} ${currentDevice?.oilUnit || "ml"}`;
  }

  function escapeHtml(s="") {
    return String(s).replace(/[&<>"']/g, m => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
    })[m]);
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
  }

  function showError(msg) {
    $("errorBox").textContent = msg;
    $("errorBox").style.display = "block";
  }
  function clearError() {
    $("errorBox").style.display = "none";
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new Error(body?.error || `请求失败 (${res.status})`);
    return body;
  }

  async function loadDevice() {
    clearError();
    try {
      const data = await api(`/api/device/${encodeURIComponent(currentCode)}`);
      currentDevice = data.device;
      $("deviceName").textContent = data.device.name;
      $("deviceCode").textContent = data.device.code;
      $("deviceLocation").textContent = data.device.location || "";
      $("oilUnit").textContent = data.device.oilUnit;
      $("inputUnit").textContent = data.device.oilUnit;
      renderDevicePhoto(data.device);
      $("lastTime").textContent = data.last ? fmtTime(data.last.created_at) : "暂无";
      $("lastAmount").textContent = data.last ? fmtAmount(data.last.amount) : "暂无";
      document.title = `${data.device.code} ${data.device.name} - 润滑加注`;
      renderHistory(data.history || []);
    } catch (e) {
      currentDevice = null;
      showError(e.message);
      $("devicePhoto").hidden = true;
      $("devicePhotoEmpty").style.display = "flex";
      $("devicePhotoCaption").textContent = "设备照片暂不可用";
      $("deviceName").textContent = "设备读取失败";
      $("history").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderHistory(rows) {
    if (!rows.length) {
      $("history").innerHTML = `<div class="empty">还没有加注记录</div>`;
      return;
    }
    $("history").innerHTML = rows.map(r => `
      <div class="row">
        <div><div class="time">${fmtTime(r.created_at)}</div><div class="note">${r.remark ? escapeHtml(r.remark) : "无备注"}</div></div>
        <div class="amount">${fmtAmount(r.amount)}</div>
      </div>`).join("");
  }

  async function loadDeviceList() {
    try {
      const data = await api("/api/devices");
      $("deviceSwitch").innerHTML = data.devices.map(d => `
        <button class="chip ${d.code === currentCode ? "active" : ""}" data-device="${escapeHtml(d.code)}">
          ${escapeHtml(d.code)} · ${escapeHtml(d.name)}
        </button>`).join("");
      document.querySelectorAll("[data-device]").forEach(btn => {
        btn.addEventListener("click", () => {
          currentCode = btn.dataset.device;
          history.pushState({}, "", `/e/${encodeURIComponent(currentCode)}`);
          $("amount").value = "";
          $("remark").value = "";
          loadDevice();
          loadDeviceList();
        });
      });
    } catch {}
  }

  $("saveBtn").addEventListener("click", async () => {
    const amount = Number($("amount").value);
    const remark = $("remark").value.trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      toast("请输入正确的本次加注量");
      $("amount").focus();
      return;
    }
    if (!currentDevice) {
      toast("设备尚未加载");
      return;
    }
    $("saveBtn").disabled = true;
    $("saveBtn").textContent = "正在保存…";
    try {
      await api(`/api/device/${encodeURIComponent(currentCode)}/records`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ amount, remark })
      });
      $("amount").value = "";
      $("remark").value = "";
      await loadDevice();
      toast("加注记录已保存到云端");
    } catch (e) {
      toast(e.message);
    } finally {
      $("saveBtn").disabled = false;
      $("saveBtn").textContent = "确认加注";
    }
  });

  $("refreshBtn").addEventListener("click", async () => {
    await loadDevice();
    toast("已刷新");
  });

  $("exportBtn").addEventListener("click", () => {
    location.href = `/api/device/${encodeURIComponent(currentCode)}/history.csv`;
  });

  $("qrBtn").addEventListener("click", () => {
    window.open(`/qr/${encodeURIComponent(currentCode)}`, "_blank");
  });

  function renderNetwork() {
    const online = navigator.onLine;
    $("networkText").textContent = online ? "网络在线" : "当前离线";
    $("networkDot").className = online ? "ok" : "bad";
  }
  addEventListener("online", () => { renderNetwork(); loadDevice(); });
  addEventListener("offline", renderNetwork);

  renderNetwork();
  loadDevice();
  loadDeviceList();
})();
