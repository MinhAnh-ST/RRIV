// ================================
// BIẾN TOÀN CỤC
// ================================
let map = null;
let stationMarkers = {};
let stationPopupOpen = null;
let currentStation = null;
let refreshTimer = null;
let refreshIntervalId = null;
let currentRefreshInterval = 1000;
let lastNDVIData = null; // Biến lưu trữ dữ liệu NDVI mới nhất




let historicalStore = {}; 
const HISTORY_LIMIT = 50; 

function updateHistoricalData(stationId, temp, hum, red, nir, timeStr) {
  if (!historicalStore[stationId]) {
    historicalStore[stationId] = { timestamps: [], temps: [], hums: [], reds: [], nirs: [] };
  }
  const store = historicalStore[stationId];
  store.timestamps.push(timeStr);
  store.temps.push(temp);
  store.hums.push(hum);
  store.reds.push(red);
  store.nirs.push(nir);
  while (store.timestamps.length > HISTORY_LIMIT) {
    store.timestamps.shift(); store.temps.shift(); store.hums.shift(); store.reds.shift(); store.nirs.shift();
  }
}


let comparisonChart = null;
let statusChart = null;
let trendChart = null;
let chartData = {}; // Lưu dữ liệu biểu đồ
let pushDataTimer = null;   // Timer gửi dữ liệu định kỳ

// Cấu hình
const MAP_CONFIG = {
  center: [10.8231, 106.6297],
  zoom: 14,
  minZoom: 6,
  maxZoom: 18,
  tileLayer: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors'
};

function getDefaultSettings() {
  return {
    tempMin: 15,
    tempMax: 35,
    humidityMin: 30,
    humidityMax: 80,
    phMin: 5.5,
    phMax: 8.5,
    batteryAlert: 20
  };
}
const labelIcons = {
  "Độ pH đất": `<i class="fas fa-vial text-success me-1"></i>`,
  "Trữ lượng nước (VWC) (%)": `<i class="fas fa-water text-info me-1"></i>`,
  "Độ dẫn điện (EC) ( dS/m)": `<i class="fas fa-bolt text-primary me-1"></i>`,
  "Nhiệt độ đất (°C)": `<i class="fas fa-thermometer-half text-danger me-1"></i>`,
  "Bức xạ Đỏ (Red) (W/m²)": `<i class="fas fa-sun text-danger me-1"></i>`,
  "Bức xạ Cận hồng ngoại (NIR) (W/m²)": `<i class="fas fa-bullseye text-secondary me-1"></i>`,
  "Mức pin (%)": `<i class="fas fa-battery-three-quarters text-success me-1"></i>`,
  "Trạng thái sạc": `<i class="fas fa-charging-station text-warning me-1"></i>`,
  "Mức điện áp (V)": `<i class="fas fa-bolt text-warning me-1"></i>`
};

const labels = [
  "Độ pH đất",
  "Trữ lượng nước (VWC) (%)",
  "Độ dẫn điện (EC) ( dS/m)",
  "Nhiệt độ đất (°C)",
  "Bức xạ Đỏ (Red) (W/m²)",
  "Bức xạ Cận hồng ngoại (NIR) (W/m²)",
  "Mức pin (%)",
  "Trạng thái sạc",
  "Mức điện áp (V)"
];

const GATEWAY_URL = window.location.origin; // FIX: relative URL, khong can IP cung
const FIREBASE_URL  = "https://rrvi-dca60-default-rtdb.asia-southeast1.firebasedatabase.app";
const FIREBASE_AUTH = "yiO8BmmDkVjx9dzfn6fqoKJH3NGvotWPZc9kgEhe";

async function getLatestFromSD(stationId) {
  try {
    // 1. Lấy danh sách file CSV trên SD
    const files = await fetchSDCardFiles();
    if (!files || files.length === 0) return null;

    // 2. Sắp xếp file mới nhất (theo tên YYYY-MM-DD)
    const latestFile = [...files].sort().reverse()[0];

    // 3. Đọc nội dung file CSV
    const csvText = await fetchCSVContent(latestFile);
    const rows = parseCSV(csvText);

    // 4. Lọc các dòng thuộc về stationId (Node ID)
    const nodeRows = rows.filter(row => {
      const nodeId = row['Node ID'] || row['node_id'] || row['nodeId'];
      return parseInt(nodeId) === parseInt(stationId);
    });
    if (nodeRows.length === 0) return null;

    // 5. Lấy dòng cuối cùng (mới nhất)
    const lastRow = nodeRows[nodeRows.length - 1];

    // 6. Trích xuất dữ liệu theo đúng thứ tự trong mảng station.data
    const ph = parseFloat(lastRow['pH']) || 0;
    const vwc = parseFloat(lastRow['Humidity (%)'] || lastRow['VWC (%)']) || 0;
    const ecUs = parseFloat(lastRow['EC (µS/cm)'] || lastRow['EC']) || 0;
    const ec = ecUs / 1000; // chuyển µS/cm → dS/m
    const temp = parseFloat(lastRow['Temperature (C)'] || lastRow['temp']) || 0;
    const red = parseFloat(lastRow['Red (W/m²)'] || lastRow['red']) || 0;
    const nir = parseFloat(lastRow['NIR (W/m²)'] || lastRow['nir']) || 0;
    const battery = parseFloat(lastRow['Battery (%)'] || lastRow['battery']) || 0;
    const voltage = parseFloat(lastRow['Voltage (V)'] || lastRow['voltage']) || 0;
    const charging = 0; // mặc định, nếu có cột thì parse

    // 7. Trả về mảng 10 phần tử
    return [ph, vwc, ec, temp, red, nir, 0, battery, charging, voltage];

  } catch (err) {
    console.error(`getLatestFromSD lỗi cho trạm ${stationId}:`, err);
    return null;
  }
}


async function fetchRealDataFromGateway() {
  try {
    const response = await fetch(`${FIREBASE_URL}/nodes.json?auth=${FIREBASE_AUTH}`);
    if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
    const nodesData = await response.json();
    if (!nodesData) throw new Error('Không có data từ Firebase');

    const newStations = [];
    for (let i = 1; i <= 6; i++) {
      const node = nodesData[`node${i}`];
      if (!node) continue;

      let d = node;
      const keys = Object.keys(node);
      if (keys.length > 0 && keys[0].startsWith('-')) {
        d = node[keys.sort().pop()];
      }

      const realLat = parseFloat(d.lat) || 0;
      const realLng = parseFloat(d.lng) || 0;
      const hasGPS  = realLat !== 0 && realLng !== 0;

      newStations.push({
        id: `STA00${i}`,
        name: `Trạm ${i}`,
        isNDVI: false,
        status: true,
        data: [
          d.ph      || 0,
          d.vwc     || 0,
          d.ec      || 0,
          d.temp    || 0,
          0, 0, 0,
          d.battery || 0,
          0,
          0
        ],
        location: {
          lat: hasGPS ? realLat : (10.8231 + (i * 0.001)),
          lng: hasGPS ? realLng : (106.6297 + (i * 0.001)),
          address: hasGPS ? `Vị trí thực tế trạm ${i}` : `Vị trí giả lập trạm ${i}`,
          isRealGPS: hasGPS
        }
      });
    
    stations = newStations;
   

    // Cập nhật lịch sử cho tất cả trạm
    const nowLabel = new Date().toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' });
    stations.forEach(station => {
      if (station.data && station.data.length >= 6) {
        updateHistoricalData(station.id, station.data[3], station.data[1], station.data[4], station.data[5], nowLabel);
      }
    });

    // Cập nhật lại currentStation nếu đang xem chi tiết
    if (currentStation) {
      const updatedStation = stations.find(s => s.id === currentStation.id);
      if (updatedStation) currentStation = updatedStation;
    }

    updateAllDisplays();

    if (currentStation && document.getElementById('stationDetail')?.style.display !== 'none') {
      const store = historicalStore[currentStation.id];
      if (store && store.timestamps.length) {
        if (window.myHumidityChart) {
          window.myHumidityChart.setOption({
            xAxis: { data: store.timestamps },
            series: [{ data: store.hums }]
          });
        }
        if (window.myTempChart) {
          window.myTempChart.setOption({
            xAxis: { data: store.timestamps },
            series: [{ data: store.temps }]
          });
        }
      }
      if (currentStation.data) updateSidebarValues(currentStation.data);
    }

    if (document.getElementById('weatherView')?.style.display === 'block') {
      initStationSelectFromRealStations();
      loadWeatherData();
    }

  } catch (error) {
    console.error('Lỗi lấy dữ liệu từ Firebase:', error);
  }
}





async function fetchNDVIFromGateway() {
  try {
    const res = await fetch(`${FIREBASE_URL}/nodes/ndvi.json?auth=${FIREBASE_AUTH}`);
    if (!res.ok) throw new Error(`Lỗi HTTP ${res.status}`);
    let raw = await res.json();
    if (!raw) return;

    const keys = Object.keys(raw);
    if (keys.length > 0 && keys[0].startsWith('-')) {
      raw = raw[keys.sort().pop()];
    }

    const data = {
      valid: true,
      ndvi: raw.ndvi      || 0,
      S2_411: { red: raw.red_up || 0, nir: raw.nir_up || 0, angle: raw.angle_up || 0 },
      S2_412: { red: raw.red_down || 0, nir: raw.nir_down || 0, angle: raw.angle_down || 0 },
      node_battery: raw.battery || 0,
      node_voltage: 0,
      node_charge_mode: 0
    };

    if (data.valid) {
      // 1. Lưu vào biến toàn cục để hàm renderStationGrid có thể sử dụng
      lastNDVIData = data;
      updateNDVIPage(data);

      // 2. Cập nhật các thẻ hiển thị chi tiết (nếu có)
      const elements = {
        'red411': data.S2_411.red.toFixed(4),
        'nir411': data.S2_411.nir.toFixed(4),
        'tilt411': data.S2_411.angle.toFixed(1),
        'red412': data.S2_412.red.toFixed(4),
        'nir412': data.S2_412.nir.toFixed(4),
        'tilt412': data.S2_412.angle.toFixed(1),
        'ndviStd': data.ndvi.toFixed(4)
      };

      for (let id in elements) {
        let el = document.getElementById(id);
        if (el) el.textContent = elements[id];
      }

      // 3. Cập nhật thanh Progress Bar NDVI
      const bar = document.getElementById('ndviStdBar');
      if (bar) {
        bar.style.width = `${Math.max(0, Math.min(100, data.ndvi * 100))}%`;
        bar.className = `progress-bar ${data.ndvi > 0.5 ? 'bg-success' : (data.ndvi > 0.2 ? 'bg-warning' : 'bg-danger')}`;
      }

      // 4. QUAN TRỌNG: Gọi hàm này để cập nhật lại Master Red/Nir trong Grid
      updateAllDisplays(); 
      
      return data;
    }
  } catch (err) {
    console.error("Lỗi lấy NDVI:", err);
  }
}



async function loadThresholdsFromGateway() {
  try {
    const response = await fetch(`${GATEWAY_URL}/api/thresholds`);
    if (!response.ok) throw new Error('Không thể lấy ngưỡng từ gateway');
    const data = await response.json();
    
    // Giả sử ta dùng ngưỡng của trạm đầu tiên cho settings toàn cục
    // (hoặc có thể cho phép cấu hình riêng từng trạm)
    if (data && data.length > 0) {
      const thresholds = data[0].values;
      settings.stations.tempMin = thresholds.temperature_min;
      settings.stations.tempMax = thresholds.temperature_max;
      settings.stations.humMin = thresholds.humidity_min;
      settings.stations.humMax = thresholds.humidity_max;
      settings.stations.phMin = thresholds.ph_min;
      settings.stations.phMax = thresholds.ph_max;
      settings.stations.batteryAlert = thresholds.battery_min;
      
      // Cập nhật lại form
      loadSettingsToForm();
      showToast('Đã tải ngưỡng từ gateway', 'success');
    }
  } catch (error) {
    console.error('Lỗi tải ngưỡng:', error);
    showToast('Không thể kết nối đến gateway để lấy ngưỡng', 'error');
  }
}

async function saveThresholdsToGateway() {
  // Lấy giá trị từ form (giống như trong saveAllSettings)
  const tempMin = parseFloat(document.getElementById('tempMin').value);
  const tempMax = parseFloat(document.getElementById('tempMax').value);
  const humMin = parseInt(document.getElementById('humMin').value);
  const humMax = parseInt(document.getElementById('humMax').value);
  const phMin = parseFloat(document.getElementById('phMin').value);
  const phMax = parseFloat(document.getElementById('phMax').value);
  const batteryMin = parseInt(document.getElementById('batteryAlert').value);

  const ecMin = parseFloat(document.getElementById('ecMin')?.value) ?? 0.5;
const ecMax = parseFloat(document.getElementById('ecMax')?.value) ?? 5.0;
  
  // Tạo payload cho tất cả các trạm (hoặc chỉ gửi cho trạm đầu)
  // Lưu ý: ESP32 có thể có nhiều trạm, cần gửi cho từng device_id
  const payload = {};
  
  // Lấy danh sách device_id từ gateway (nếu có) hoặc từ stations hiện tại
  // Cách đơn giản: gửi cho từng station trong mảng stations (đã có id)
  for (const station of stations) {
    // Tìm device_id tương ứng (có thể station.id dạng số, cần chuyển thành "STA00x")
    const deviceId = `STA00${station.id}`;  // Ví dụ: STA001, STA002,...
    payload[deviceId] = {
      temperature_min: tempMin,
      temperature_max: tempMax,
      humidity_min: humMin,
      humidity_max: humMax,
      ph_min: phMin,
      ph_max: phMax,
      ec_min: ecMin,      // thêm
      ec_max: ecMax,      // thêm
      battery_min: batteryMin
    };
  }
  
  try {
    const response = await fetch(`${GATEWAY_URL}/api/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      showToast('Đã đồng bộ ngưỡng lên gateway', 'success');
      // Cập nhật lại settings local
      settings.stations = { tempMin, tempMax, humMin, humMax, phMin, phMax, batteryAlert: batteryMin };
      localStorage.setItem('rriv_settings', JSON.stringify(settings));
    } else {
      showToast('Lỗi khi gửi ngưỡng lên gateway', 'error');
    }
  } catch (error) {
    console.error('Lỗi lưu ngưỡng:', error);
    showToast('Không thể kết nối đến gateway', 'error');
  }
}

function getAllowedStations() {
  if (!currentUser) return [];
  // Nếu là admin hoặc được sét quyền 'all' thì trả về tất cả trạm
  if (currentUser.role === 'admin' || currentUser.stations === 'all') {
    return stations;
  }
  // Nếu là mảng ID, lọc lấy các trạm có ID nằm trong danh sách cho phép
  if (Array.isArray(currentUser.stations)) {
    return stations.filter(s => currentUser.stations.includes(s.id));
  }
  return [];
}

// ========== HỆ THỐNG CẢNH BÁO NGƯỠNG ==========
function checkStationThresholds(station) {
  const alerts = [];
  if (!station || !station.data || station.data.length < 8) return alerts;
  
  const ph = station.data[0];
  const vwc = station.data[1];
  const temp = station.data[3];
  const battery = station.data[7];
  
  // Lấy ngưỡng từ settings (toàn cục)
  const phMin = settings.stations.phMin;
  const phMax = settings.stations.phMax;
  const humMin = settings.stations.humMin;
  const humMax = settings.stations.humMax;
  const tempMin = settings.stations.tempMin;
  const tempMax = settings.stations.tempMax;
  const batteryMin = settings.stations.batteryAlert;
  
  if (ph < phMin) alerts.push({ type: 'pH', level: 'low', value: ph, threshold: phMin, text: `pH thấp (${ph} < ${phMin})` });
  else if (ph > phMax) alerts.push({ type: 'pH', level: 'high', value: ph, threshold: phMax, text: `pH cao (${ph} > ${phMax})` });
  
  if (vwc < humMin) alerts.push({ type: ' Hàm lượng nước (VWC)', level: 'low', value: vwc, threshold: humMin, text: ` Hàm lượng nước (VWC) thấp (${vwc}% < ${humMin}%)` });
  else if (vwc > humMax) alerts.push({ type: ' Hàm lượng nước (VWC)', level: 'high', value: vwc, threshold: humMax, text: ` Hàm lượng nước (VWC) cao (${vwc}% > ${humMax}%)` });
  
  if (temp < tempMin) alerts.push({ type: 'Nhiệt độ', level: 'low', value: temp, threshold: tempMin, text: `Nhiệt độ thấp (${temp}°C < ${tempMin}°C)` });
  else if (temp > tempMax) alerts.push({ type: 'Nhiệt độ', level: 'high', value: temp, threshold: tempMax, text: `Nhiệt độ cao (${temp}°C > ${tempMax}°C)` });
  
  if (battery < batteryMin) alerts.push({ type: 'Pin', level: 'low', value: battery, threshold: batteryMin, text: `Pin yếu (${battery}% < ${batteryMin}%)` });
  
  return alerts;
}

// Hàm lấy màu marker dựa trên cảnh báo
function getMarkerColorByAlerts(alerts) {
  if (alerts.some(a => a.type === 'Pin' && a.level === 'low')) return '#FF9800'; // Cam cho pin yếu
  if (alerts.length > 0) return '#F44336'; // Đỏ cho các cảnh báo khác
  return '#4CAF50'; // Xanh bình thường
}



function getLatestDataFromServer(stationIndex) {
  if (!stations[stationIndex]) return null;
  const newData = generateRandomStationData(stations[stationIndex].id);
  stations[stationIndex].data = newData;
  return newData;
}

/**
 * Cập nhật toàn bộ giao diện sau khi dữ liệu thay đổi
 */
function updateAllDisplays() {
  // Cập nhật marker trên bản đồ
  if (map && stationMarkers) {
    addStationMarkers();
  }
  // Nếu đang ở trang monitoring (grid)
  if (document.getElementById('chartView')?.style.display === 'block') {
    renderStationGrid();
  }
  // Nếu đang ở trang chi tiết trạm -> KHÔNG RELOAD, chỉ cập nhật số liệu trên giao diện hiện tại
  if (document.getElementById('stationDetail')?.style.display !== 'none' && currentStation) {
    // Chỉ cập nhật sidebar và biểu đồ, không gọi lại showStation()
    const idx = stations.findIndex(s => s.id === currentStation.id);
    if (idx !== -1) {
      const newData = stations[idx].data;
      if (newData) {
        updateSidebarValues(newData);        // cập nhật số liệu, màu sắc, badge
        updateChartWithNewData(newData);     // cập nhật biểu đồ (thêm điểm mới)
      }
    }
  }
  updateStationsCount();
  updateActiveStationsCount();
  //updateVirtualLightSensors();
  
  // Toast cảnh báo (giữ nguyên)
  stations.forEach(station => {
    const alerts = checkStationThresholds(station);
    if (alerts.length > 0 && !station._alertShown) {
      showToast(`${station.name}: ${alerts[0].text}`, 'warning');
      station._alertShown = true;
    } else if (alerts.length === 0) {
      station._alertShown = false;
    }
  });
}

let stations = [];
for (let i = 1; i <= 6; i++) {
  stations.push({
    id: i,
    name: `Trạm ${i}`,
    status: true,
    data: [],   // sẽ được random sau
    
    settings: null,
    location: {
      lat: 10.8225 + (i * 0.001),
      lng: 106.6275 + (i * 0.001),
      accuracy: 5,
      lastUpdate: new Date().toISOString(),
      address: `Địa chỉ trạm ${i}`
    }
  });
}



// ================================
// HÀM KHỞI TẠO
// ================================
function initializeStations() {
  const savedStations = localStorage.getItem("stations");
  if (savedStations) {
    try {
      stations = JSON.parse(savedStations);
    } catch (error) {
      console.error('❌ Lỗi parse JSON:', error);
    }
  }
  
  stations.forEach(station => {
    if (!station.settings) station.settings = getDefaultSettings();
    if (!station.location) station.location = getDefaultLocation(station.id);
  });
}


function getDefaultLocation(id) {
  const baseLat = 10.8231;
  const baseLng = 106.6297;
  return {
    lat: baseLat + (id * 0.01),
    lng: baseLng + (id * 0.01),
    accuracy: 5.0,
    lastUpdate: new Date().toISOString(),
    address: `Vị trí trạm ${id}`
  };
}



function initMap() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer) return;

  map = L.map('map', {
    scrollWheelZoom: true,
    dragging: true,
    tap: false
  });
  // ❌ BỎ DÒNG .setView(MAP_CONFIG.center, MAP_CONFIG.zoom)
  
  L.tileLayer(MAP_CONFIG.tileLayer, {
    attribution: MAP_CONFIG.attribution,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom
  }).addTo(map);
  
  addStationMarkers();
  
  // ✅ THÊM DÒNG NÀY - tự động zoom sau khi có marker
  if (stations.length > 0) {
    const bounds = L.latLngBounds(
      stations
        .filter(s => s.id !== 'S2-411' && s.id !== 'S2-412' && s.location)
        .map(s => [s.location.lat, s.location.lng])
    );
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
  }
}

function addStationMarkers() {
  // 1. Xóa các marker cũ trên bản đồ
  Object.values(stationMarkers).forEach(marker => {
    if (marker) map.removeLayer(marker);
  });
  stationMarkers = {};

  // 2. Lặp qua danh sách trạm để vẽ marker mới
  stations.forEach((station, index) => {
    // --- BƯỚC LỌC TRẠM ---
    // Không vẽ các trạm S2-411, S2-412 và các trạm không có tọa độ
    if (station.id === 'S2-411' || station.id === 'S2-412' || !station.location) {
      return; // Bỏ qua trạm này, chuyển sang trạm kế tiếp
    }

    // 3. Khởi tạo marker cho các trạm hợp lệ (S1-S6)
    const marker = L.marker([station.location.lat, station.location.lng], {
      icon: createCustomMarker(station),
      riseOnHover: true,
      title: station.name
    }).addTo(map);
    
    // 4. Gán nội dung Popup
    const popupContent = createStationPopup(station, index);
    marker.bindPopup(popupContent, {
      maxWidth: 300,
      className: 'station-popup'
    });
    
    // 5. Lưu vào danh sách quản lý marker
    stationMarkers[station.id] = marker;
    
    // 6. Xử lý sự kiện click
    marker.on('click', function() {
      Object.values(stationMarkers).forEach(m => {
        if (m !== marker && m.isPopupOpen()) m.closePopup();
      });
      marker.openPopup();
      map.setView([station.location.lat, station.location.lng], 19);
    });
  });
}


function createCustomMarker(station) {
  // Check dữ liệu cảm biến thực (bỏ qua voltage mặc định ở index 9)
  const hasData = station.isNDVI
    ? station.data && (station.data[0] !== 0 || station.data[1] !== 0 || station.data[6] !== 0)
    : station.data && (station.data[0] !== 0 || station.data[1] !== 0 || station.data[2] !== 0 || station.data[3] !== 0);

  if (!hasData) {
    return L.divIcon({
      html: `<div class="custom-marker" style="background-color: #adb5bd; width: 32px; height: 32px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"><div style="transform: rotate(45deg); color: white; font-weight: bold; text-align: center; line-height: 28px; font-size: 14px;">${station.id}</div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32]
    });
  }

  const alerts = checkStationThresholds(station);
  const color = getMarkerColorByAlerts(alerts);
  
  return L.divIcon({
    html: `<div class="custom-marker" style="background-color: ${color}; width: 32px; height: 32px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"><div style="transform: rotate(45deg); color: white; font-weight: bold; text-align: center; line-height: 28px; font-size: 14px;">${station.id}</div></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32]
  });
}

function createStationPopup(station, index) {/*Phiên bản 2.0 cập nhật 2/4/2026*/
  // Check dữ liệu cảm biến thực (bỏ qua voltage mặc định ở index 9)
  const hasData = station.isNDVI
    ? station.data && (station.data[0] !== 0 || station.data[1] !== 0 || station.data[6] !== 0)
    : station.data && (station.data[0] !== 0 || station.data[1] !== 0 || station.data[2] !== 0 || station.data[3] !== 0);

  const statusText = !hasData
    ? '<span class="badge text-dark" style="background-color:#fd7e14;">Không có tín hiệu</span>'
    : station.status
        ? '<span class="badge bg-success">Đang hoạt động</span>'
        : '<span class="badge bg-danger">Ngừng hoạt động</span>';

  const alerts = checkStationThresholds(station);
  let alertsHtml = '';
  if (alerts.length > 0) {
    alertsHtml = `<hr class="my-1"><div class="alert alert-warning py-1 my-1 small" style="background:#fff3cd; border-radius:6px;"><i class="fas fa-exclamation-triangle text-danger"></i> <strong>Cảnh báo:</strong><br>${alerts.map(a => a.text).join('<br>')}</div>`;
  }
  
  
  
  return `
    <div class="station-popup-content" style="min-width: 300px;">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <h6 class="mb-0"><i class="fas fa-microchip me-1"></i> ${station.name}</h6>
        ${statusText}
      </div>
      <hr class="my-1">
      ${hasData ? `
      <div class="text-muted small mb-1"><strong>Cảm biến ES PH SOIL 01</strong></div>
      <div class="station-info mb-2">
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-vial text-warning"></i> Độ pH:</span>
          <strong>${station.data[0]}</strong>
        </div>
        <hr class="my-1">
        <div class="text-muted small mb-1"><strong>Cảm biến TEROS 12:</strong></div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-water text-primary"></i> Hàm lượng nước thể tích (VWC %):</span>
          <strong>${station.data[1]}%</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-bolt text-secondary"></i> Độ dẫn điện (EC):</span>
          <strong>${station.data[2]} dS/m</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-thermometer-half text-danger"></i> Nhiệt độ đất:</span>
          <strong>${station.data[3]}°C</strong>
        </div>
        <hr class="my-1">
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-battery-three-quarters text-success"></i> Pin hệ thống:</span>
          <strong>${station.data[7].toFixed(1)}%</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-solar-panel text-info"></i> Trạng thái:</span>
          <strong>${station.data[8] === 1 ? "⚡ Đang sạc" : (station.data[8] === 2 ? "✅ Pin đầy" : "🔋 Đang dùng pin")}</strong>
        </div>
        ${alertsHtml}
      </div>` : `
      <div class="text-center py-3">
        <i class="fas fa-satellite-dish fa-2x mb-2 d-block" style="color:#adb5bd;"></i>
        <span class="text-muted small">Chưa nhận được dữ liệu từ trạm</span>
      </div>`}
      
      <div class="gps-info small text-muted mb-3">
        <div><i class="fas fa-map-marker-alt"></i> ${station.location.lat.toFixed(6)}, ${station.location.lng.toFixed(6)}</div>
      </div>
      
      <div class="d-grid gap-2">
        <button class="btn btn-sm btn-primary" onclick="showStationFromMap(${index})">
          <i class="fas fa-chart-line me-1"></i> Xem chi tiết
        </button>
      </div>
    </div>
  `;
}
// ================================
// GIAO DIỆN
// ================================
// ================================
// HÀM HIỂN THỊ BẢN ĐỒ CHÍNH
// ================================
function showMainDashboard() {
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
   // Dọn dẹp timer và biểu đồ trước
   if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  hideAllViews();
  
  const mainDashboard = document.getElementById('mainDashboard');
  if (mainDashboard) {
    mainDashboard.style.display = 'block';
    
    // Xóa bản đồ cũ nếu đã tồn tại để tránh xung đột bộ nhớ
    if (map) {
      map.remove();
      map = null;
    }

    // Đợi một khoảng thời gian cực ngắn (50-100ms) để DOM ổn định
    setTimeout(() => {
      initMap(); // Khởi tạo lại toàn bộ từ đầu
      console.log("Bản đồ đã được khởi tạo lại.");
    }, 100);
    
    updateStationsCount();
    updateActiveStationsCount();
  } else {
    createMainDashboard();
  }
  
  updateNavActive('mainDashboard');
}


// Hàm tạo lại mainDashboard nếu bị mất
function createMainDashboard() {
  const mainContent = document.querySelector('.main-content');
  mainContent.innerHTML = `
    <div id="mainDashboard">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="section-title mb-0">
          <i class="fas fa-map-marked-alt me-2"></i>Bản đồ vị trí các trạm
        </h2>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-outline-primary" onclick="zoomToAllStations()">
            <i class="fas fa-search-location"></i> Hiển thị tất cả
          </button>
          <button class="btn btn-sm btn-outline-success" onclick="refreshMap()">
            <i class="fas fa-sync-alt"></i> Làm mới
          </button>
        </div>
      </div>
      
      <div id="map" style="height: calc(100vh - 180px); border-radius: 12px; border: 1px solid #ddd;"></div>
      
      <div id="stationSummary" class="mt-3">
        <div class="row" id="activeStationsCount"></div>
      </div>
    </div>
  `;
  
  initMap();
}

function showStationFromMap(index) {
  Object.values(stationMarkers).forEach(marker => {
    if (marker.isPopupOpen()) marker.closePopup();
  });
  showStation(index);
}


// Khai báo biến toàn cục để lưu instance biểu đồ
let myHumidityChart = null;
let myTempChart = null;



// Hàm bổ trợ để lấy màu theo độ pH (giống hàm cũ của bạn)
function getPhColor(ph) {
  if (ph < 5) return '#ff4d4d'; // Axit
  if (ph > 8) return '#4d79ff'; // Kiềm
  return '#2ecc71'; // Trung tính
}

/* */






function getSunTime(lat, type) {
  // Giả lập tính toán đơn giản dựa trên vĩ độ
  // Thực tế cần thư viện phức tạp hơn, đây là giá trị tượng trưng
  const hourOffset = lat > 10 ? 0 : 0.5; 
  if (type === 'sunrise') return `${5 + Math.floor(hourOffset)}:${30 + Math.floor(Math.random() * 20)}`;
  if (type === 'sunset') return `${17 + Math.floor(hourOffset)}:${45 + Math.floor(Math.random() * 15)}`;
}

// Hàm xác định màu sắc dựa trên giá trị pH
function getPhColor(ph) {
  if (ph < 5) return '#e74c3c'; // Đất rất chua - Đỏ
  if (ph < 6.5) return '#f1c40f'; // Đất hơi chua - Vàng
  if (ph <= 7.5) return '#2ecc71'; // Đất trung tính - Xanh lá
  return '#9b59b6'; // Đất kiềm - Tím
}

function showStation(index) {
  if (!requireLoginForStationDetail()) return;

  // Dừng timer cũ nếu có (chỉ để an toàn, vì giờ không dùng timer riêng nữa)
  if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
  }

  hideAllViews();
  const oldDetail = document.getElementById('stationDetail');
  if (oldDetail) oldDetail.remove();

  currentStation = stations[index];
  const data = currentStation.data;

  // --- Lấy lịch sử từ store, nếu chưa có thì tạo mới với 1 điểm hiện tại ---
  let store = historicalStore[currentStation.id];
  let timestamps = [], temps = [], hums = [];
  if (store && store.timestamps.length) {
      timestamps = [...store.timestamps];
      temps = [...store.temps];
      hums = [...store.hums];
  } else {
      const now = new Date().toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' });
      timestamps = [now];
      temps = [data[3]];
      hums = [data[1]];
      // Lưu lại store
      updateHistoricalData(currentStation.id, data[3], data[1], data[4], data[5], now);
      store = historicalStore[currentStation.id];
  }

  // --- Phần HTML giữ nguyên như cũ (chú ý có 2 div: humidityEChart, tempEChart) ---
  const batteryLevel = data[7];
  const batteryBg = batteryLevel < 30 ? 'bg-danger' : (batteryLevel < 50 ? 'bg-warning' : 'bg-success');

  const detailHtml = `
  <style>
    .station-dashboard-wrapper { background: #f4f7f6; width: 100%; border-radius: 15px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); margin-top: 10px; }
    .stats-sidebar { background: #ffffff; padding: 20px; border-right: 1px solid #e0e6ed; }
    .stat-box { background: #f8fafc; border-radius: 12px; padding: 15px; margin-bottom: 15px; border-left: 5px solid #dee2e6; transition: all 0.3s ease; }
    .stat-box.temp { border-left-color: #e74c3c; }
    .stat-box.hum { border-left-color: #3498db; }
    .bar-container { display: flex; justify-content: space-around; margin-top: 25px; padding: 10px; background: #fff; border-radius: 12px; }
    .bar-glass { width: 20px; height: 100px; background: #eee; border-radius: 10px; position: relative; overflow: hidden; }
    .bar-fill { position: absolute; bottom: 0; width: 100%; border-radius: 10px; transition: height 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
    .charts-main { background: #ffffff; padding: 25px; }
    .chart-card { background: #fff; border-radius: 15px; padding: 15px; margin-bottom: 20px; border: 1px solid #f0f0f0; box-shadow: 0 4px 6px rgba(0,0,0,0.02); }
    .battery-shell { width: 30px; height: 15px; border: 1.5px solid #555; border-radius: 3px; padding: 1px; display: inline-block; vertical-align: middle; }
    .battery-level-bar { height: 100%; border-radius: 1px; }
  </style>

  <div id="stationDetail" class="station-dashboard-wrapper">
    <div class="row g-0">
        <div class="col-md-3 stats-sidebar">
            <div class="mb-4">
                <h6 class="fw-bold text-primary text-uppercase small mb-1">Trạm quan trắc</h6>
                <h5 class="fw-bold">${currentStation.name}</h5>
                <div class="mt-2">
                    <div class="battery-shell">
                        <div class="battery-level-bar ${batteryBg}" style="width: ${batteryLevel}%"></div>
                    </div>
                    <span class="ms-1 fw-bold small" id="batteryPercent">${batteryLevel}%</span>
                    <div class="d-flex justify-content-between small">
                    <span><i class="fas fa-solar-panel text-info"></i> Trạng thái:</span>
                   <strong>${data[8] === 1 ? "⚡ Đang sạc" : (data[8] === 2 ? "✅ Pin đầy" : "🔋 Đang dùng pin")}</strong>
                   </div>
                   
          
                </div>
            </div>

            <div class="stat-box temp">
                <small class="text-muted">Nhiệt độ đất</small>
                <div class="d-flex justify-content-between align-items-end">
                    <h3 class="mb-0 fw-bold" id="tempValue">${data[3]}°C</h3>
                    <i class="fas fa-thermometer-half text-danger opacity-50"></i>
                </div>
            </div>

            <div class="stat-box hum">
                <small class="text-muted">Hàm lượng nước thể tích (VWC %)</small>
                <div class="d-flex justify-content-between align-items-end">
                    <h3 class="mb-0 fw-bold text-primary" id="humidityValue">${data[1]}%</h3>
                    <i class="fas fa-water text-primary opacity-50"></i>
                </div>
            </div>

            <div class="bar-container shadow-sm">
                <div class="text-center">
                    <div class="bar-glass mx-auto">
                        <div class="bar-fill" id="ecBarFill" style="height: ${(data[2]/5)*100}%; background: #9b59b6;"></div>
                    </div>
                    <small class="d-block mt-2 fw-bold text-muted">EC: <span id="ecValue">${data[2]}</span></small>
                </div>
                <div class="text-center">
                    <div class="bar-glass mx-auto">
                        <div class="bar-fill" id="phBarFill" style="height: ${(data[0]/14)*100}%; background: ${getPhColor(data[0])};"></div>
                    </div>
                    <small class="d-block mt-2 fw-bold text-muted">pH: <span id="phValue">${data[0]}</span></small>
                </div>
            </div>

            <div class="mt-4 p-2 bg-light rounded small text-muted">
                <div><i class="fas fa-microchip me-2"></i></div>
                <div><i class="fas fa-map-marker-alt me-2"></i><span id="stationAddress">Đang tải địa chỉ...</span></div>
            </div>
               
        </div>

        <div class="col-md-9 charts-main">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h5 class="fw-bold"><i class="fas fa-chart-line me-2 text-primary"></i>BIỂU ĐỒ PHÂN TÍCH</h5>
                <button class="btn btn-light btn-sm shadow-sm" onclick="hideAllViews()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        
            <div class="chart-card">
                <div id="humidityEChart" style="width: 100%; height: 280px;"></div>
                <div id="tempEChart" style="width: 100%; height: 280px;"></div>
           </div>
           
        </div>
    </div>
  </div>
  `;


  const mainContent = document.querySelector('.main-content');
  const existingDetail = document.getElementById('stationDetail');
  if (existingDetail) existingDetail.remove();
  mainContent.insertAdjacentHTML('beforeend', detailHtml);
  updateStationAddress(currentStation.location.lat, currentStation.location.lng);

  // === KHỞI TẠO BIỂU ĐỒ VỚI DỮ LIỆU LỊCH SỬ ===
  setTimeout(() => {
      // Biểu đồ độ ẩm
      const humDom = document.getElementById('humidityEChart');
      if (humDom) {
          if (window.myHumidityChart) window.myHumidityChart.dispose?.();
          window.myHumidityChart = echarts.init(humDom);
          window.myHumidityChart.setOption({
              title: { text: 'Hàm lượng nước thể tích (VWC %)', left: 'left', textStyle: { fontSize: 12, color: '#999' } },
              tooltip: { trigger: 'axis', formatter: '{b}: <b>{c}%</b>' },
              xAxis: { type: 'category', boundaryGap: false, data: timestamps },
              yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
              series: [{
                  name: ' Hàm lượng nước (VWC)',
                  data: hums,
                  type: 'line',
                  smooth: true,
                  lineStyle: { width: 4, color: '#3498db' },
                  areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1, [{offset:0, color:'rgba(52,152,219,0.4)'},{offset:1, color:'transparent'}]) },
                  itemStyle: { color: '#3498db' }
              }]
          });
      }

      // Biểu đồ nhiệt độ
      const tempDom = document.getElementById('tempEChart');
      if (tempDom) {
          if (window.myTempChart) window.myTempChart.dispose?.();
          window.myTempChart = echarts.init(tempDom);
          window.myTempChart.setOption({
              title: { text: 'Nhiệt độ đất (°C)', left: 'left', textStyle: { fontSize: 12, color: '#999' } },
              tooltip: { trigger: 'axis', formatter: '{b}: <b>{c}°C</b>' },
              xAxis: { type: 'category', boundaryGap: false, data: timestamps },
              yAxis: { type: 'value', min: 0, max: 80, axisLabel: { formatter: '{value}°C' } },
              series: [{
                  name: 'Nhiệt độ',
                  data: temps,
                  type: 'line',
                  smooth: true,
                  lineStyle: { width: 4, color: '#e74c3c' },
                  areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1, [{offset:0, color:'rgba(231,76,60,0.4)'},{offset:1, color:'transparent'}]) },
                  itemStyle: { color: '#e74c3c' }
              }]
          });
      }

      window.addEventListener('resize', () => {
          if (window.myHumidityChart) window.myHumidityChart.resize();
          if (window.myTempChart) window.myTempChart.resize();
      });
  }, 200);

  // KHÔNG CÒN setInterval CẬP NHẬT Ở ĐÂY NỮA
  
}





function updateSidebarValues(newData) {
  // Lấy ngưỡng từ settings
  const phMin = settings.stations.phMin;
  const phMax = settings.stations.phMax;
  const humMin = settings.stations.humMin;
  const humMax = settings.stations.humMax;
  const tempMin = settings.stations.tempMin;
  const tempMax = settings.stations.tempMax;
  const batteryMin = settings.stations.batteryAlert;
  
  // Cập nhật nhiệt độ
  const tempEl = document.getElementById('tempValue');
  if (tempEl) {
    const temp = newData[3];
    tempEl.innerHTML = `${temp}°C`;
    if (temp < tempMin || temp > tempMax) tempEl.classList.add('alert-value');
    else tempEl.classList.remove('alert-value');
  }

  // Cập nhật độ ẩm
  const humEl = document.getElementById('humidityValue');
  if (humEl) {
    const hum = newData[1];
    humEl.innerHTML = `${hum}%`;
    if (hum < humMin || hum > humMax) humEl.classList.add('alert-value');
    else humEl.classList.remove('alert-value');
  }

  // Cập nhật pH
  const phSpan = document.getElementById('phValue');
  if (phSpan) {
    const ph = newData[0];
    phSpan.innerText = ph;
    if (ph < phMin || ph > phMax) phSpan.classList.add('alert-value');
    else phSpan.classList.remove('alert-value');
  }
  
  // Cập nhật EC (chỉ hiển thị, không cảnh báo nếu chưa có ngưỡng)
  const ecSpan = document.getElementById('ecValue');
  if (ecSpan) ecSpan.innerText = newData[2];

  // Cập nhật thanh bar EC (giá trị tối đa giả sử 5  dS/m)
  const ecBar = document.getElementById('ecBarFill');
  if (ecBar) {
    const ecPercent = (newData[2] / 20) * 100;
    ecBar.style.height = `${ecPercent}%`;
  }

  // Cập nhật thanh bar pH (giá trị tối đa 14)
  const phBar = document.getElementById('phBarFill');
  if (phBar) {
    const phPercent = (newData[0] / 9) * 100;
    phBar.style.height = `${phPercent}%`;
    phBar.style.background = getPhColor(newData[0]);
  }

  // Cập nhật pin
  const batteryPercentSpan = document.getElementById('batteryPercent');
  const batteryBar = document.querySelector('.battery-level-bar');
  if (batteryPercentSpan && batteryBar) {
    const battery = newData[7];
    batteryPercentSpan.innerText = `${battery}%`;
    batteryBar.style.width = `${battery}%`;
    // Cập nhật màu sắc và class cảnh báo
    if (battery < batteryMin) {
      batteryBar.className = 'battery-level-bar bg-danger';
      batteryPercentSpan.classList.add('alert-value');
    } else if (battery < 50) {
      batteryBar.className = 'battery-level-bar bg-warning';
      batteryPercentSpan.classList.remove('alert-value');
    } else {
      batteryBar.className = 'battery-level-bar bg-success';
      batteryPercentSpan.classList.remove('alert-value');
    }
  }
  
  // Cập nhật badge cảnh báo tổng số trên tiêu đề
  const ph = newData[0], vwc = newData[1], temp = newData[3], battery = newData[7];
  const isPhAlert = (ph < phMin || ph > phMax);
  const isVwcAlert = (vwc < humMin || vwc > humMax);
  const isTempAlert = (temp < tempMin || temp > tempMax);
  const isBatteryAlert = (battery < batteryMin);
  const alertCount = [isPhAlert, isVwcAlert, isTempAlert, isBatteryAlert].filter(Boolean).length;
  
  const titleEl = document.querySelector('#stationDetail .stats-sidebar h5');
  if (titleEl) {
    let badgeSpan = titleEl.querySelector('.alert-badge');
    if (alertCount > 0) {
      if (!badgeSpan) {
        badgeSpan = document.createElement('span');
        badgeSpan.className = 'alert-badge';
        titleEl.appendChild(badgeSpan);
      }
      badgeSpan.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${alertCount} cảnh báo`;
    } else {
      if (badgeSpan) badgeSpan.remove();
    }
  }
}

function updateChartWithNewData(newData) {
  const timeNow = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  
  // Cập nhật biểu đồ độ ẩm
  if (window.myHumidityChart) {
    const opt = window.myHumidityChart.getOption();
    let cats = opt.xAxis[0].data;
    let vals = opt.series[0].data;
    cats.push(timeNow);
    vals.push(newData[1]);
    if (cats.length > 15) { cats.shift(); vals.shift(); }
    window.myHumidityChart.setOption({ xAxis: { data: cats }, series: [{ data: vals }] });
  }
  
  // Cập nhật biểu đồ nhiệt độ
  if (window.myTempChart) {
    const opt = window.myTempChart.getOption();
    let cats = opt.xAxis[0].data;
    let vals = opt.series[0].data;
    cats.push(timeNow);
    vals.push(newData[3]);
    if (cats.length > 15) { cats.shift(); vals.shift(); }
    window.myTempChart.setOption({ xAxis: { data: cats }, series: [{ data: vals }] });
  }
}



// Tạo dữ liệu lịch sử cho một trạm theo khoảng thời gian
function generateHistoricalData(stationId, range) {
  const now = new Date();
  let points = [];
  let labels = [];
  let count = 0;
  
  switch(range) {
    case 'day': // 24 giờ, mỗi 1 giờ
      for (let i = 0; i < 24; i++) {
        const d = new Date(now);
        d.setHours(now.getHours() - 23 + i, 0, 0, 0);
        labels.push(d.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' }));
      }
      count = 24;
      break;
    case 'week': // 7 ngày
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - 6 + i);
        labels.push(d.toLocaleDateString('vi-VN', { weekday:'short', day:'numeric' }));
      }
      count = 7;
      break;
    case 'month': // 30 ngày
      for (let i = 0; i < 30; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - 29 + i);
        labels.push(d.toLocaleDateString('vi-VN', { day:'numeric', month:'numeric' }));
      }
      count = 30;
      break;
    case 'year': // 12 tháng
      for (let i = 0; i < 12; i++) {
        const d = new Date(now);
        d.setMonth(now.getMonth() - 11 + i);
        labels.push(d.toLocaleDateString('vi-VN', { month:'short' }));
      }
      count = 12;
      break;
  }
  
  // Xu hướng riêng cho từng trạm (dựa vào ID)
  const baseTemp = 25 + (stationId * 0.5);
  const baseHum = 60 - (stationId * 2);
  const basePh = 6.5 + (stationId * 0.2);
  const baseEc = 80 - (stationId * 5);
  
  const temps = Array.from({length: count}, (_, i) => {
    let trend = Math.sin(i / count * Math.PI) * 3;
    return +(baseTemp + trend + (Math.random() * 2 - 1)).toFixed(1);
  });
  const hums = Array.from({length: count}, (_, i) => {
    let trend = Math.cos(i / count * Math.PI) * 10;
    let val = baseHum + trend + (Math.random() * 5 - 2.5);
    return Math.min(100, Math.max(20, Math.floor(val)));
  });
  const phs = Array.from({length: count}, (_, i) => {
    let trend = Math.sin(i / count * Math.PI * 0.5) * 0.5;
    return +(basePh + trend + (Math.random() * 0.3 - 0.15)).toFixed(1);
  });
  const ecs = Array.from({length: count}, (_, i) => {
    let trend = - (i / count) * 0.2;
    let val = baseEc + trend + (Math.random() * 0.1 - 0.05);
    return +val.toFixed(2);
  });
  
  return { labels, temps, hums, phs, ecs };
}

let allChartsRefreshTimer = null;
let chartTempAll = null, chartHumAll = null, chartPhAll = null, chartEcAll = null;
let currentTimeRange = 'month';
let historicalCache = {};

/*BỔ SUNG TỔNG HỢP BIỂU ĐỒ THEO NGÀY<TUẦN< THÁNG 23/4/2026*/
// Lấy nội dung file CSV từ gateway
async function fetchCSVContent(fileName) {
  const res = await fetch(`${GATEWAY_URL}/api/sd/download?file=${encodeURIComponent(fileName)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// Parse CSV thành mảng object, dựa theo header dòng đầu
function parseCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];
  for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length !== headers.length) continue;
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = values[idx]; });
      result.push(obj);
  }
  return result;
}

// Lấy tất cả dữ liệu của một node từ nội dung file CSV
function getNodeDataFromCSV(csvRows, nodeId) {
  return csvRows.filter(row => parseInt(row['Node ID']) === nodeId);
}

// Nhóm dữ liệu theo ngày (YYYY-MM-DD) và tính trung bình các chỉ số
function groupByDay(nodeData) {
  const dayMap = new Map(); // key: YYYY-MM-DD
  nodeData.forEach(row => {
      // Timestamp định dạng "4/23/2026 16:38" -> cần parse
      const ts = row['Timestamp'];
      if (!ts) return;
      const parts = ts.split(' ');
      const datePart = parts[0]; // "4/23/2026"
      // Chuyển thành YYYY-MM-DD (giả sử US: MM/DD/YYYY)
      const [month, day, year] = datePart.split('/');
      const dateKey = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
      
      const temp = parseFloat(row['Temperature (C)']);
      const hum = parseFloat(row['Humidity (%)']);
      const ph = parseFloat(row['pH']);
      const ec = parseFloat(row['EC (µS/cm)']); // đơn vị µS/cm, có thể chuyển về dS/m nếu cần
      if (isNaN(temp) || isNaN(hum) || isNaN(ph) || isNaN(ec)) return;
      
      if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, { temps: [], hums: [], phs: [], ecs: [] });
      }
      const entry = dayMap.get(dateKey);
      entry.temps.push(temp);
      entry.hums.push(hum);
      entry.phs.push(ph);
      entry.ecs.push(ec);
  });
  
  // Tính trung bình
  const result = [];
  for (const [date, values] of dayMap.entries()) {
      const avgTemp = values.temps.reduce((a,b) => a+b,0) / values.temps.length;
      const avgHum = values.hums.reduce((a,b) => a+b,0) / values.hums.length;
      const avgPh = values.phs.reduce((a,b) => a+b,0) / values.phs.length;
      const avgEc = values.ecs.reduce((a,b) => a+b,0) / values.ecs.length;
      result.push({ date, avgTemp, avgHum, avgPh, avgEc });
  }
  result.sort((a,b) => a.date.localeCompare(b.date));
  return result;
}

// Lấy dữ liệu chi tiết theo thời gian (giữ nguyên timestamp) cho range 'day'
function getTimeSeriesData(nodeData) {
  const points = [];
  nodeData.forEach(row => {
      const ts = row['Timestamp'];
      if (!ts) return;
      const temp = parseFloat(row['Temperature (C)']);
      const hum = parseFloat(row['Humidity (%)']);
      const ph = parseFloat(row['pH']);
      const ec = parseFloat(row['EC (µS/cm)']);
      if (isNaN(temp) || isNaN(hum) || isNaN(ph) || isNaN(ec)) return;
      points.push({ timestamp: ts, temp, hum, ph, ec });
  });
  points.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  return points;
}

// Hàm chính: lấy dữ liệu lịch sử cho một node, theo range ('day', 'week', 'month')
async function getHistoricalDataFromSD(stationId, range) {
  // 1. Chuyển stationId (có thể là "STA001" hoặc 1) thành số nguyên
  let stationNumber;
  if (typeof stationId === 'number') {
    stationNumber = stationId;
  } else {
    const match = String(stationId).match(/\d+/);
    stationNumber = match ? parseInt(match[0], 10) : 1;
  }

  const now = new Date();
  let fileNames = [];

  // 2. Tạo danh sách tên file cần đọc dựa theo range
  if (range === 'day') {
    const today = now.toISOString().slice(0, 10);
    fileNames = [`${today}.csv`];
  } else if (range === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      fileNames.push(d.toISOString().slice(0, 10) + '.csv');
    }
  } else if (range === 'month') {
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      fileNames.push(d.toISOString().slice(0, 10) + '.csv');
    }
  }

  // 3. Lấy danh sách file có thật trên SD
  let existingFiles = [];
  try {
    existingFiles = await fetchSDCardFiles(); // phải trả về mảng tên file, ví dụ ["2026-04-24.csv", ...]
  } catch (err) {
    console.warn("Không thể lấy danh sách file từ SD:", err);
  }

  let allRows = [];
  for (const fname of fileNames) {
    if (!existingFiles.includes(fname)) continue;
    try {
      const csvText = await fetchCSVContent(fname);
      const rows = parseCSV(csvText);        // parseCSV phải trả về mảng object với các cột đúng tên
      const nodeRows = rows.filter(row => {
        const nodeId = row['Node ID'] || row['node_id'] || row['nodeId'];
        return parseInt(nodeId) === stationNumber;
      });
      allRows.push(...nodeRows);
    } catch (err) {
      console.warn(`Không đọc được file ${fname}:`, err);
    }
  }

  // 4. Nếu không có dữ liệu thật → fallback sang giả lập
  if (allRows.length === 0) {
    console.warn(`⚠️ Không có dữ liệu CSV cho trạm ${stationId},.`);
   // return generateHistoricalData(stationNumber, range);
  }

  // 5. Xử lý dữ liệu theo range
  if (range === 'day') {
    // Giữ nguyên timestamp (giờ:phút)
    const points = allRows.map(row => ({
      timestamp: row['Timestamp'] || row['timestamp'],
      temp: parseFloat(row['Temperature (C)'] || row['temperature']),
      hum: parseFloat(row['Humidity (%)'] || row['humidity']),
      ph:  parseFloat(row['pH']),
      ec:  parseFloat(row['EC (µS/cm)'] || row['ec'])
    })).filter(p => !isNaN(p.temp) && !isNaN(p.hum) && !isNaN(p.ph) && !isNaN(p.ec))
      .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

    const labels = points.map(p => p.timestamp);
    const temps = points.map(p => p.temp);
    const hums = points.map(p => p.hum);
    const phs = points.map(p => p.ph);
    const ecs = points.map(p => p.ec);
    return { labels, temps, hums, phs, ecs };
  } 
  else {
    // Nhóm theo ngày (YYYY-MM-DD) và tính trung bình
    const dayMap = new Map();
    for (const row of allRows) {
      let rawTimestamp = row['Timestamp'] || row['timestamp'];
      if (!rawTimestamp) continue;
      // Chuyển timestamp "4/23/2026 16:38" -> "2026-04-23"
      let dateKey;
      if (rawTimestamp.includes('/')) {
        const [month, day, year] = rawTimestamp.split(' ')[0].split('/');
        dateKey = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
      } else {
        dateKey = rawTimestamp.split(' ')[0]; // nếu đã có định dạng YYYY-MM-DD
      }
      const temp = parseFloat(row['Temperature (C)'] || row['temperature']);
      const hum = parseFloat(row['Humidity (%)'] || row['humidity']);
      const ph = parseFloat(row['pH']);
      const ec = parseFloat(row['EC (µS/cm)'] || row['ec']);
      if (isNaN(temp) || isNaN(hum) || isNaN(ph) || isNaN(ec)) continue;

      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, { temps: [], hums: [], phs: [], ecs: [] });
      }
      const entry = dayMap.get(dateKey);
      entry.temps.push(temp);
      entry.hums.push(hum);
      entry.phs.push(ph);
      entry.ecs.push(ec);
    }

    const grouped = Array.from(dayMap.entries()).map(([date, vals]) => ({
      date,
      avgTemp: vals.temps.reduce((a,b)=>a+b,0)/vals.temps.length,
      avgHum: vals.hums.reduce((a,b)=>a+b,0)/vals.hums.length,
      avgPh: vals.phs.reduce((a,b)=>a+b,0)/vals.phs.length,
      avgEc: vals.ecs.reduce((a,b)=>a+b,0)/vals.ecs.length
    })).sort((a,b) => a.date.localeCompare(b.date));

    const labels = grouped.map(g => g.date);
    const temps = grouped.map(g => g.avgTemp);
    const hums = grouped.map(g => g.avgHum);
    const phs = grouped.map(g => g.avgPh);
    const ecs = grouped.map(g => g.avgEc);
    return { labels, temps, hums, phs, ecs };
  }
}





/**---------------------------------------------- */


async function renderAllCharts() {
  const range = currentTimeRange;
  const stationNames = stations.map(s => s.name);
  const container = document.getElementById('allChartsView');

  // Hiển thị loading
  const loadingDiv = document.createElement('div');
  loadingDiv.id = 'chartLoading';
  //loadingDiv.innerHTML = `<div class="text-center p-5"><i class="fas fa-spinner fa-spin"></i> Đang tải dữ liệu từ thẻ SD...</div>`;
  //loadingOverlay.id = 'chartLoadingOverlay';

  const overlay = document.getElementById('globalLoadingOverlay');
  overlay.style.display = 'flex';   // quan trọng: 'flex' chứ không phải 'block'

//const overlay = document.getElementById('globalLoadingOverlay');
//overlay.style.display = 'flex';   // hiện
// ... sau khi xong

  if (container && !document.getElementById('chartLoading')) {
      container.prepend(loadingDiv);
  }

  try {
      // Thu thập dữ liệu cho tất cả trạm
      const allData = [];
      for (const station of stations) {
          const data = await getHistoricalDataFromSD(station.id, range);
          if (!data || !data.labels || data.labels.length === 0) {
              console.warn(`Không có dữ liệu cho trạm ${station.id}, dùng mảng rỗng.`);
              allData.push({
                  name: station.name,
                  labels: [], temps: [], hums: [], phs: [], ecs: []
              });
              continue;
          }
          allData.push({
              name: station.name,
              labels: data.labels,
              temps: data.temps,
              hums: data.hums,
              phs: data.phs,
              ecs: data.ecs
          });
          const key = `${station.id}_${range}`;
          historicalCache[key] = data;
      }

      // Xóa loading
      const loadingElem = document.getElementById('chartLoading');
      if (loadingElem) loadingElem.remove();

      // Lọc các trạm có dữ liệu thực tế
      const validData = allData.filter(d => d.labels && d.labels.length > 0);
      if (validData.length === 0) {
          console.warn('Không có dữ liệu để vẽ');
          if (container) {
              const msg = document.createElement('div');
              msg.className = 'alert alert-warning';
              msg.innerText = 'Không có dữ liệu trong khoảng thời gian này.';
              container.appendChild(msg);
              setTimeout(() => msg.remove(), 5000);
          }
          return;
      }

      const labels = validData[0].labels; // dùng dữ liệu của trạm đầu tiên có dữ liệu
      const colorPalette = ['#5470c6', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452'];

      function renderMultiLineChart(domId, dataKey, titleText, yName, unit, minY, maxY) {
          const dom = document.getElementById(domId);
          if (!dom) return null;
          let chart = echarts.getInstanceByDom(dom);
          if (!chart) chart = echarts.init(dom);

          const series = allData.map((station, idx) => ({
              name: station.name,
              type: 'line',
              data: station[dataKey] || [],
              smooth: true,
              lineStyle: { width: 2, color: colorPalette[idx % colorPalette.length] },
              symbol: 'circle',
              symbolSize: 4,
              emphasis: { focus: 'series' }
          }));

          chart.setOption({
              title: { text: titleText, left: 'left', textStyle: { fontSize: 12, color: '#999' } },
              tooltip: { trigger: 'axis' },
              legend: { data: stationNames, type: 'scroll', orient: 'horizontal', left: 'center', top: 0, itemWidth: 20 },
              grid: { top: 30, bottom: 10, containLabel: true },
              //xAxis: { type: 'category', boundaryGap: false, data: labels, axisLabel: { rotate: 30, interval: 'auto' } },

              xAxis: {
                type: 'category',
                boundaryGap: false,
                data: labels,
                axisLabel: {
                  rotate: 30,
                  interval: 'auto',
                  formatter: function(value) {
                    // Ví dụ: value = "4/24/2026 10:30:15" -> muốn hiện "4/24/2026 10:30"
                    if (typeof value === 'string' && value.includes(':')) {
                      let parts = value.split(' ');
                      if (parts.length === 2) {
                        let timeParts = parts[1].split(':');
                        if (timeParts.length >= 2) {
                          return parts[0] + ' ' + timeParts[0] + ':' + timeParts[1];
                        }
                      } else if (parts.length === 1 && value.includes(':')) {
                        let timeParts = value.split(':');
                        if (timeParts.length >= 2) return timeParts[0] + ':' + timeParts[1];
                      }
                    }
                    return value;
                  }
                }
              },
              yAxis: { type: 'value', name: yName, min: minY, max: maxY, axisLabel: { formatter: `{value} ${unit}` } },
              series: series
          });
          return chart;
      }

      chartTempAll = renderMultiLineChart('chartTempAll', 'temps', 'Nhiệt độ', '', '°C', 0, 100);
      chartHumAll = renderMultiLineChart('chartHumAll', 'hums', '(VWC %)', '', '%', -40, 60);
      chartPhAll = renderMultiLineChart('chartPhAll', 'phs', 'pH đất', '', 'pH', 3, 9);
      chartEcAll = renderMultiLineChart('chartEcAll', 'ecs', '(EC)', '', 'dS/m', 0, 20);
      overlay.style.display = 'none';   // ẩn

  } catch (error) {
      console.error('Lỗi renderAllCharts:', error);
      const loadingElem = document.getElementById('chartLoading');
      if (loadingElem) loadingElem.remove();
      if (typeof showToast === 'function') {
          showToast('Lỗi tải dữ liệu biểu đồ: ' + error.message, 'error');
      }
  }

  console.log("allData[0] =", allData[0]);
}
async function refreshAllChartsWithFilter() {
  const select = document.getElementById('timeRangeSelect');
  if (select) currentTimeRange = select.value;
  // Xóa cache cũ để tải lại dữ liệu mới theo range
  historicalCache = {};
  await renderAllCharts();
  
}



function showAllCharts() {
  if (!requireLoginForStationDetail()) return;
  if (refreshTimer) clearInterval(refreshTimer);
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  
  hideAllViews();
  const allChartsView = document.getElementById('allChartsView');
  if (allChartsView) {
      allChartsView.style.display = 'block';
      // Reset về 'week' (hoặc 'day' tùy ý)
      currentTimeRange = 'day';
      historicalCache = {};
      if (document.getElementById('timeRangeSelect')) {
          document.getElementById('timeRangeSelect').value = 'day';
      }
      // Gọi render bất đồng bộ
      renderAllCharts().then(() => {
          // Sau khi vẽ xong, có thể set timer refresh tự động mỗi 5 phút nếu muốn
          if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
          allChartsRefreshTimer = setInterval(() => {
            refreshAllChartsWithFilter();
        }, 300000);
      });
  }
  if (typeof updateNavActive === 'function') updateNavActive('allChartsView');
}

function closeAllChartsView() {
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  showMainDashboard();
}

// Resize khi thay đổi cửa sổ
window.addEventListener('resize', function() {
  if (chartTempAll) chartTempAll.resize();
  if (chartHumAll) chartHumAll.resize();
  if (chartPhAll) chartPhAll.resize();
  if (chartEcAll) chartEcAll.resize();
});



/*phiên bản chi tiết trạm update 2-4-2-26 */

// ================================
// HÀM TIỆN ÍCH
// ================================
// ================================
// HÀM ẨN TẤT CẢ VIEW

// ================================
function hideAllViews() {
  const views = [
    'mainDashboard', 'stationListView', 'stationDetail', 'chartView',
    'alertsView', 'settingsView', 'agriAssistantView', 
    'utilitiesView', 'weatherView', 'aboutView','allChartsView','ndviView' 
  ];
  
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'none';
    }
  });
}

function updateStationsCount() {
  const activeCount = stations.filter(s => s.status).length;
  const totalCount = stations.length;
  const countEl = document.getElementById('stationsCount');
  if (countEl) countEl.textContent = `${activeCount}/${totalCount}`;
}

function updateActiveStationsCount() {
  const activeCount = stations.filter(s => s.status).length;
  const lowBatteryCount = stations.filter(s => s.data[7] < 30).length;
  const offlineCount = stations.filter(s => !s.status).length;
  
  const container = document.getElementById('activeStationsCount');
  if (container) {
    container.innerHTML = `
      <div class="col-md-4">
        <div class="card bg-success bg-opacity-10 border-success">
          <div class="card-body py-2">
            <h6 class="card-title mb-0">
              <i class="fas fa-check-circle text-success me-2"></i>
              Đang hoạt động: <strong>${activeCount}</strong>
            </h6>
          </div>
        </div>
      </div>
      <div class="col-md-4">
        <div class="card bg-warning bg-opacity-10 border-warning">
          <div class="card-body py-2">
            <h6 class="card-title mb-0">
              <i class="fas fa-battery-quarter text-warning me-2"></i>
              Pin yếu: <strong>${lowBatteryCount}</strong>
            </h6>
          </div>
        </div>
      </div>
      <div class="col-md-4">
        <div class="card bg-danger bg-opacity-10 border-danger">
          <div class="card-body py-2">
            <h6 class="card-title mb-0">
              <i class="fas fa-times-circle text-danger me-2"></i>
              Mất kết nối: <strong>${offlineCount}</strong>
            </h6>
          </div>
        </div>
      </div>
    `;
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `alert alert-${type === 'error' ? 'danger' : type} alert-dismissible fade show`;
  toast.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}


// ================================
// HÀM LÀM MỚI BẢN ĐỒ
// ================================
function refreshMap() {
  if (map) {
    // Đóng tất cả popup
    Object.values(stationMarkers).forEach(marker => {
      if (marker.isPopupOpen()) marker.closePopup();
    });
    
    // Làm mới bản đồ
    addStationMarkers();
    updateStationsCount();
    updateActiveStationsCount();
    
    showToast('🔄 Đã làm mới bản đồ', 'success');
  } else {
    // Nếu map chưa được khởi tạo
    initMap();
  }
}


// Hàm chỉ đường đến trạm
function navigateToStation() {
  if (!currentStation || !currentStation.location) return;
  
  const lat = currentStation.location.lat;
  const lng = currentStation.location.lng;
  const stationName = encodeURIComponent(currentStation.name);
  
  // Mở Google Maps hoặc ứng dụng bản đồ
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_name=${stationName}`;
  
  window.open(url, '_blank');
  showToast('🗺️ Đang mở chỉ đường...', 'info');
}

let realDataInterval = null;

function startRealDataPolling() {
  if (realDataInterval) clearInterval(realDataInterval);
  // Gọi ngay lập tức
  fetchRealDataFromGateway();
  // Sau đó mỗi 30 giây (hoặc theo interval trong settings)
  realDataInterval = setInterval(fetchRealDataFromGateway, 60000);
}


window.onload = async function() {
  console.log('🚀 Trang đang khởi động...');
  initializeAuthSystem();
  initializeStations();
  initSettings();
  
  // Hiển thị loading
  const overlay = document.getElementById('globalLoadingOverlay');
  overlay.style.display = 'flex';
  
  // Fetch dữ liệu từ gateway
  await fetchRealDataFromGateway();
  await fetchNDVIFromGateway();
  
  overlay.style.display = 'none';
  showMainDashboard();
  console.log('🎯 Khởi động hoàn tất');
};

// ================================


// Thêm các hàm cần thiết khác ở đây
function showStationList() {
  hideAllViews();
  const container = document.createElement('div');
  container.id = 'stationListView';
  container.innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h2 class="section-title mb-0">
        <i class="fas fa-th-list me-2"></i>Danh sách trạm
      </h2>
      <button class="btn btn-sm btn-outline-primary" onclick="showMainDashboard()">
        <i class="fas fa-map-marked-alt me-1"></i> Xem bản đồ
      </button>
    </div>
    <div class="row" id="stationCards"></div>
  `;
  document.querySelector('.main-content').appendChild(container);
  container.style.display = 'block';
  createStationCards();
}

function createStationCards() {
  const container = document.getElementById("stationCards");
  if (!container) return;
  
  container.innerHTML = '';
  stations.forEach((station, index) => {
    const statusText = station.status ? 'Đang hoạt động' : 'Ngừng hoạt động';
    const statusColor = station.status ? 'text-success' : 'text-danger';
    
    container.innerHTML += `
      <div class="col-md-4 mb-4">
        <div class="card station-card p-3 shadow-sm" onclick="showStation(${index})" style="cursor:pointer;">
          <div class="d-flex align-items-center mb-1">
            <i class="bi bi-upc-scan me-2 station-icon"></i>
            <span class="station-id">${station.id}</span>
            <span class="ms-2">${station.name}</span>
          </div>
          <div class="d-flex align-items-center mb-1">
            <i class="bi bi-circle-fill me-2 ${statusColor}"></i>
            <span class="${statusColor}">${statusText}</span>
          </div>
          <div class="d-flex align-items-center mb-1">
            <i class="fas fa-map-marker-alt me-2 text-primary"></i>
            <small class="text-muted">${station.location.lat.toFixed(4)}, ${station.location.lng.toFixed(4)}</small>
          </div>
          <div class="d-flex align-items-center mb-1">
            <i class="fas fa-battery-half me-2 text-info"></i>
            <span class="text-muted">${station.data[7].toFixed(1)}%</span>
            
          </div>
          <div class="d-grid gap-2">
          <button class="btn btn-sm btn-primary" onclick="showStationFromMap(${index})">
          <i class="fas fa-chart-line me-1"></i> Xem chi tiết
          </button>
        
        </div>
      </div>
    `;
  });
}

/*update 19/1/2026 */
/*


/*Hàm showMonitoring update ngày 2-4-2-26*/

// Cập nhật hàm showMonitoring để gọi đúng hàm bảng
// Hàm showMonitoring để kích hoạt
function showMonitoring() {
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (!requireLoginForStationDetail()) return;
  hideAllViews();
  const chartView = document.getElementById('chartView');
  if (chartView) {
    chartView.style.display = 'block';
    renderStationGrid(); 
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(renderStationGrid, 30000);
  }
  updateNavActive('chartView');
}

function updateSunPathUI() {
  const sunIcon = document.getElementById('sun-position-mini');
  if (!sunIcon) return;

  const now = new Date();
  const hours = now.getHours() + now.getMinutes() / 60;

  // Giả định giờ mọc/lặn (Có thể thay bằng hàm getSunTime của anh)
  const sunrise = 5.75; // 5:45
  const sunset = 18.0;  // 18:00

  let percentage;
  if (hours >= sunrise && hours <= sunset) {
      // Đang là ban ngày: tính % từ mọc đến lặn
      percentage = ((hours - sunrise) / (sunset - sunrise)) * 100;
      sunIcon.innerHTML = '<i class="fas fa-sun"></i>';
      document.querySelector('.sun-track-mini-wrapper').classList.remove('is-night-mode');
  } else {
      // Ban đêm: cho icon về vị trí 0 hoặc 100 và đổi thành mặt trăng
      percentage = (hours > sunset) ? 100 : 0;
      sunIcon.innerHTML = '<i class="fas fa-moon"></i>';
      document.querySelector('.sun-track-mini-wrapper').classList.add('is-night-mode');
  }

  // Công thức lượng giác để di chuyển icon theo đường cong
  const angle = (percentage / 100) * Math.PI;
  const x = percentage; 
  const y = Math.sin(angle) * 100; // Độ cao của cung

  sunIcon.style.left = `${x}%`;
  sunIcon.style.top = `${100 - y}%`;
}

function renderStationGrid() {
  const grid = document.getElementById('stationGrid');
 
  if (!grid) return;
  grid.innerHTML = ''; 

  stations.slice(0, 6).forEach((station) => {
    // Lấy ngưỡng từ settings
    const phMin = settings.stations.phMin;
    const phMax = settings.stations.phMax;
    const humMin = settings.stations.humMin;
    const humMax = settings.stations.humMax;
    const tempMin = settings.stations.tempMin;
    const tempMax = settings.stations.tempMax;
    const batteryMin = settings.stations.batteryAlert;
    
    // Lấy giá trị
    const ph = station.data[0];
    const vwc = station.data[1];
    const temp = station.data[3];
    const battery = station.data[7].toFixed(1);
    
    // Xác định class cho từng giá trị
    const phClass = (ph < phMin || ph > phMax) ? 'text-danger fw-bold' : '';
    const vwcClass = (vwc < humMin || vwc > humMax) ? 'text-danger fw-bold' : '';
    const tempClass = (temp < tempMin || temp > tempMax) ? 'text-danger fw-bold' : '';
    const batteryClass = (battery < batteryMin) ? 'text-danger fw-bold' : '';
    
    // Tạo alert badge tổng (nếu cần)
    const alerts = checkStationThresholds(station);
    let alertBadge = '';
    if (alerts.length > 0) {
      alertBadge = `<div class="small text-danger mt-1"><i class="fas fa-exclamation-triangle"></i> ${alerts.length} cảnh báo</div>`;
    }

    const statusText = station.status 
      ? '<span class="badge bg-success-light text-success" style="font-size:0.6rem">ONLINE</span>' 
      : '<span class="badge bg-danger-light text-danger" style="font-size:0.6rem">OFFLINE</span>';

    const nodeHtml = `
      <div class="col-lg-4 col-md-6 col-node">
        <div class="station-custom-card">
          <div class="d-flex justify-content-between align-items-start">
            <h6 class="mb-0 fw-bold" style="font-size: 0.9rem;">
              <i class="fas fa-microchip me-1 text-primary"></i> ${station.name}
            </h6>
            ${statusText}
          </div>
          <hr>
          <div class="sensor-title">Cảm biến ES PH SOIL 01</div>
          <div class="data-row">
            <span><i class="fas fa-vial text-warning me-1"></i> Độ pH:</span>
            <strong class="${phClass}">${ph}</strong>
          </div>

          <hr>
          <div class="sensor-title">Cảm biến TEROS 12</div>
          <div class="data-row">
            <span><i class="fas fa-water text-primary me-1"></i> Hàm lượng nước thể tích (VWC %):</span>
            <strong class="${vwcClass}">${vwc}%</strong>
          </div>
          <div class="data-row">
            <span><i class="fas fa-bolt text-secondary me-1"></i> Dẫn điện (EC):</span>
            <strong>${station.data[2]} <small class="text-muted"> dS/m</small></strong>
          </div>
          <div class="data-row">
            <span><i class="fas fa-thermometer-half text-danger me-1"></i> Nhiệt độ đất:</span>
            <strong class="${tempClass}">${temp}°C</strong>
          </div>

          <hr class="mt-auto">
          <div class="d-flex justify-content-between align-items-center">
            <div style="font-size: 0.65rem; color: #adb5bd;">
              <i class="fas fa-map-marker-alt"></i> ${station.location.lat.toFixed(4)}, ${station.location.lng.toFixed(4)}
            </div>
            <div class="small">
              <i class="fas fa-battery-three-quarters ${batteryClass.includes('danger') ? 'text-danger' : (station.data[7] < 30 ? 'text-danger' : 'text-success')} me-1"></i>
              <strong class="${batteryClass}" style="font-size: 0.85rem;">${battery}%</strong>
            </div>
          </div>
          ${alertBadge}
        </div>
      </div>
    `;
    grid.innerHTML += nodeHtml;
  });

  

if (stations && stations[0]) {
  // --- LẤY DỮ LIỆU ---
  // Nếu có lastNDVIData từ API thì lấy, nếu không thì lấy mặc định từ stations (đang là 0)
  
  // Cụm Sensor 411
  const red411 = lastNDVIData ? lastNDVIData.S2_411.red.toFixed(4) : (stations[0].data[4] || '0.0');
  const nir411 = lastNDVIData ? lastNDVIData.S2_411.nir.toFixed(4) : (stations[0].data[5] || '0.0');
  const tilt411 = lastNDVIData ? lastNDVIData.S2_411.angle.toFixed(1) : '0.0';

  // Cụm Sensor 412
  const red412 = lastNDVIData ? lastNDVIData.S2_412.red.toFixed(4) : '0.0';
  const nir412 = lastNDVIData ? lastNDVIData.S2_412.nir.toFixed(4) : '0.0';
  const tilt412 = lastNDVIData ? lastNDVIData.S2_412.angle.toFixed(1) : '0.0';

  // --- ĐỔ VÀO HTML ---
  
  // Đổ dữ liệu Sensor 411
  const mRed1 = document.getElementById('411-red');
  const mNir1 = document.getElementById('411-nir');
  const mTilt1 = document.getElementById('411-tilt');
  if (mRed1) mRed1.textContent = red411;
  if (mNir1) mNir1.textContent = nir411;
  if (mTilt1) mTilt1.textContent = tilt411;

  // Đổ dữ liệu Sensor 412
  const mRed2 = document.getElementById('412-red');
  const mNir2 = document.getElementById('412-nir');
  const mTilt2 = document.getElementById('412-tilt');
  if (mRed2) mRed2.textContent = red412;
  if (mNir2) mNir2.textContent = nir412;
  if (mTilt2) mTilt2.textContent = tilt412;
}

if (typeof updateSunPathUI === "function") updateSunPathUI();
}
function renderComparisonTable() {
  const tbody = document.getElementById('comparisonTableBody');
  if (!tbody) return;

  // Cấu hình các hàng: [Tên, Index dữ liệu, Đơn vị, Class màu]
  const rowsConfig = [
    { name: 'Độ pH Đất', idx: 0, unit: 'pH', cls: 'val-ph', icon: 'fa-vial' },
    { name: 'Hàm lượng nước thể tích (VWC %)', idx: 1, unit: '%', cls: 'val-vwc', icon: 'fa-water' },
    { name: 'Dẫn điện (EC)', idx: 2, unit: ' dS/m', cls: 'val-ec', icon: 'fa-bolt' },
    { name: 'Nhiệt độ đất', idx: 3, unit: '°C', cls: 'val-temp', icon: 'fa-thermometer-half' },
    { name: 'Pin hệ thống', idx: 7, unit: '%', cls: 'val-pin', icon: 'fa-battery-half' }
  ];

  let html = '';

  rowsConfig.forEach(config => {
    html += `<tr>
      <td>
        <span class="param-name"><i class="fas ${config.icon} me-2"></i>${config.name}</span>
        <span class="unit-label">Đơn vị: ${config.unit}</span>
      </td>`;

    // Lấy dữ liệu của 6 trạm cho thông số này
    for (let i = 0; i < 6; i++) {
      const station = stations[i];
      if (station) {
        const value = station.data[config.idx];
        // Thêm cảnh báo nếu trạm offline
        const opacity = station.status ? '1' : '0.3';
        html += `<td class="${config.cls}" style="opacity: ${opacity}">${value}</td>`;
      } else {
        html += `<td class="text-muted">-</td>`;
      }
    }
    html += `</tr>`;
  });

  tbody.innerHTML = html;

  // Cập nhật Master Data (Red/NIR)
 // if (stations && stations[0]) {
 //   document.getElementById('master-red').textContent = stations[0].data[4] || '0.0';
//document.getElementById('master-nir').textContent = stations[0].data[5] || '0.0';
  //}
//}

if (stations && stations[0]) {
  // --- LẤY DỮ LIỆU ---
  // Nếu có lastNDVIData từ API thì lấy, nếu không thì lấy mặc định từ stations (đang là 0)
  
  // Cụm Sensor 411
  const red411 = lastNDVIData ? lastNDVIData.S2_411.red.toFixed(4) : (stations[0].data[4] || '0.0');
  const nir411 = lastNDVIData ? lastNDVIData.S2_411.nir.toFixed(4) : (stations[0].data[5] || '0.0');
  const tilt411 = lastNDVIData ? lastNDVIData.S2_411.angle.toFixed(1) : '0.0';

  // Cụm Sensor 412
  const red412 = lastNDVIData ? lastNDVIData.S2_412.red.toFixed(4) : '0.0';
  const nir412 = lastNDVIData ? lastNDVIData.S2_412.nir.toFixed(4) : '0.0';
  const tilt412 = lastNDVIData ? lastNDVIData.S2_412.angle.toFixed(1) : '0.0';

  // --- ĐỔ VÀO HTML ---
  
  // Đổ dữ liệu Sensor 411
  const mRed1 = document.getElementById('411-red');
  const mNir1 = document.getElementById('411-nir');
  const mTilt1 = document.getElementById('411-tilt');
  if (mRed1) mRed1.textContent = red411;
  if (mNir1) mNir1.textContent = nir411;
  if (mTilt1) mTilt1.textContent = tilt411;

  // Đổ dữ liệu Sensor 412
  const mRed2 = document.getElementById('412-red');
  const mNir2 = document.getElementById('412-nir');
  const mTilt2 = document.getElementById('412-tilt');
  if (mRed2) mRed2.textContent = red412;
  if (mNir2) mNir2.textContent = nir412;
  if (mTilt2) mTilt2.textContent = tilt412;
}

if (typeof updateSunPathUI === "function") updateSunPathUI();
}


// ================================
// HÀM XUẤT DỮ LIỆU BIỂU ĐỒ CSV
// ================================
function exportChartCSV() {

  if (!canExportCSV()) {
    showToast('Bạn không có quyền xuất dữ liệu CSV', 'error');
    return;
  }
  try {
    
    if (!chartData || !chartData.timestamps || !chartData.stations) {
      showToast('❌ Không có dữ liệu biểu đồ để xuất', 'error');
      return;
    }

    // Tạo headers
    const headers = ["Thời gian", "Trạm", "Nhiệt độ (°C)", " Hàm lượng nước (VWC) (%)", "EC", "pH", "Pin (%)"];
    
    // Tạo dữ liệu
    const rows = [];
    
    chartData.timestamps.forEach((timestamp, timeIndex) => {
      Object.entries(chartData.stations).forEach(([stationId, stationData]) => {
        const station = stations.find(s => s.id == stationId);
        if (station) {
          const row = [
            timestamp.toLocaleString("vi-VN"),
            station.name,
            stationData.temperature[timeIndex] || "",
            stationData.humidity[timeIndex] || "",
            stationData.ec[timeIndex] || "",
            stationData.ph[timeIndex] || "",
            stationData.battery[timeIndex] || ""
          ];
          rows.push(row);
        }
      });
    });

    // Tạo CSV content
    const csvContent = [headers.join(","), ...rows.map(row => row.join(","))].join("\n");
    
    // Xuất file
    const BOM = "\uFEFF";
    const blob = new Blob([BOM + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chart_data_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    
    // Dọn dẹp
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    showToast('📈 Đã xuất dữ liệu biểu đồ CSV', 'success');
    
  } catch (error) {
    console.error('Lỗi xuất chart CSV:', error);
    showToast('❌ Lỗi xuất dữ liệu biểu đồ', 'error');
  }
}

//================================
// HỆ THỐNG ĐĂNG NHẬP ĐƠN GIẢN
// ================================

let currentUser = null;
let users = [];

// Tài khoản mặc định
const DEFAULT_USERS = [
  {
    id: 1,
    username: 'RRIV-ADMIN',
    password: 'admin@123',
    fullname: 'Quản trị viên',
    email: '',
    role: 'admin',
    permissions: 'all',
    stations: 'all'
  },
  {
    id: 2,
    username: 'RRIV-USER',
    password: 'user123',
    fullname: 'user',
    email: '',
    role: 'operator',
    permissions: ['view'],
    stations: [1, 2,3,4,5,6] // Chỉ xem trạm 1 và 2
  },
  
];

// Khởi tạo hệ thống user
function initializeAuthSystem() {
  // Đọc users từ localStorage
  const savedUsers = localStorage.getItem('riv_users');
  if (savedUsers) {
    users = JSON.parse(savedUsers);
    
    // --- BỔ SUNG USER MỚI TỪ DEFAULT_USERS ---
    let needUpdate = false;
    DEFAULT_USERS.forEach(defaultUser => {
      // Kiểm tra xem user đã tồn tại trong users chưa (theo username)
      const exists = users.some(u => u.username === defaultUser.username);
      if (!exists) {
        users.push(defaultUser);
        needUpdate = true;
        console.log(`Đã thêm user mới: ${defaultUser.username}`);
      }
    });
    
    // Nếu có thêm user mới, lưu lại vào localStorage
    if (needUpdate) {
      localStorage.setItem('riv_users', JSON.stringify(users));
    }
  } else {
    // Chưa có dữ liệu thì dùng mặc định
    users = [...DEFAULT_USERS];
    localStorage.setItem('riv_users', JSON.stringify(users));
  }

  // Kiểm tra đăng nhập tự động (nếu có)
  const savedUser = localStorage.getItem('riv_current_user');
  if (savedUser) {
    try {
      const userData = JSON.parse(savedUser);
      const user = users.find(u => u.username === userData.username && u.password === userData.password);
      if (user) {
        loginUser(user);
      }
    } catch (error) {
      console.error('Lỗi load user:', error);
    }
  }
  updateLoginUI();

  // Xử lý form đăng nhập
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();
      processLogin();
    });
  }

  // Close user dropdown when clicking outside
  document.addEventListener('click', function(event) {
    const dropdown = document.getElementById('userDropdown');
    const profile = document.getElementById('userProfile');
    
    if (dropdown && dropdown.style.display === 'block' && 
        !dropdown.contains(event.target) && 
        !profile.contains(event.target)) {
      dropdown.style.display = 'none';
    }
  });
  // Thêm event listener cho form tạo tài khoản
  const createAccountForm = document.getElementById('createAccountForm');
  if (createAccountForm) {
    createAccountForm.addEventListener('submit', function(e) {
      e.preventDefault();
      createNewAccount();
    });
  }
  
  // Thêm event listener cho form reset mật khẩu
  const forgotPasswordBtn = document.querySelector('#forgotPasswordModal .btn-warning');
  if (forgotPasswordBtn) {
    forgotPasswordBtn.addEventListener('click', requestPasswordReset);
  }
}

// Cập nhật giao diện đăng nhập
// ================================
function updateLoginUI() {
  const guestView = document.getElementById('guestView');
  const loggedInView = document.getElementById('loggedInView');
  
  if (currentUser) {
    // ĐÃ đăng nhập: Ẩn guestView, hiển thị loggedInView
    guestView.classList.add('d-none');
    guestView.classList.remove('d-flex');
    loggedInView.classList.remove('d-none');
    loggedInView.classList.add('d-flex');
    
    // Cập nhật thông tin người dùng
    const initials = getInitials(currentUser.fullname || currentUser.username);
    const userInitials = document.getElementById('userInitials');
    const displayUserName = document.getElementById('displayUserName');
    const displayUserRole = document.getElementById('displayUserRole');
    
    if (userInitials) userInitials.textContent = initials;
    if (displayUserName) displayUserName.textContent = currentUser.fullname || currentUser.username;
    if (displayUserRole) {
      displayUserRole.textContent = 
        currentUser.role === 'admin' ? 'Quản trị viên' :
        currentUser.role === 'operator' ? 'Vận hành' : 'Người xem';
    }
    
    // Cập nhật màu avatar theo role
    const avatar = document.querySelector('#loggedInView .avatar-circle');
    if (avatar) {
      avatar.style.background = currentUser.role === 'admin' ? 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)' :
                               currentUser.role === 'operator' ? 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)' :
                               'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)';
    }
    
    // Hiển thị/ẩn nút quản lý tài khoản cho admin
    const manageAccountsItem = document.getElementById('manageAccountsItem');
    if (manageAccountsItem) {
      manageAccountsItem.style.display = currentUser.role === 'admin' ? 'block' : 'none';
    }
    
  } else {
    // CHƯA đăng nhập: Hiển thị guestView, ẩn loggedInView
    guestView.classList.remove('d-none');
    guestView.classList.add('d-flex');
    loggedInView.classList.add('d-none');
    loggedInView.classList.remove('d-flex');
    
    // Ẩn các chức năng cần đăng nhập
    hideFeaturesRequiringLogin();
  }
}


// Lấy chữ cái đầu của tên
function getInitials(name) {
  return name.split(' ')
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .substring(0, 2);
}

// Hiển thị modal đăng nhập
function showLoginModal() {
  // Reset form
  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.reset();
  
  // Reset message
  const loginMessage = document.getElementById('loginMessage');
  if (loginMessage) {
    loginMessage.classList.add('d-none');
    loginMessage.textContent = '';
  }
  
  // Show modal
  const modalElement = document.getElementById('loginModal');
  if (modalElement) {
    const modal = new bootstrap.Modal(modalElement);
    modal.show();
  }
}
// Thêm hàm xử lý khi modal bị ẩn
document.addEventListener('DOMContentLoaded', function() {
  const loginModal = document.getElementById('loginModal');
  if (loginModal) {
    loginModal.addEventListener('hidden.bs.modal', function () {
      // Reset form khi modal đóng
      const loginForm = document.getElementById('loginForm');
      if (loginForm) loginForm.reset();
      
      const loginMessage = document.getElementById('loginMessage');
      if (loginMessage) {
        loginMessage.classList.add('d-none');
        loginMessage.textContent = '';
      }
    });
  }
});

function showForgotPasswordModal() {
  // Close login modal
  const loginModal = bootstrap.Modal.getInstance(document.getElementById('loginModal'));
  if (loginModal) loginModal.hide();
  
  // Show forgot password modal
  const forgotModal = new bootstrap.Modal(document.getElementById('forgotPasswordModal'));
  forgotModal.show();
}

// Xử lý đăng nhập
function processLogin() {
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const remember = document.getElementById('rememberMe')?.checked;
  const loginMessage = document.getElementById('loginMessage');
  
  // Reset error message
  if (loginMessage) {
    loginMessage.classList.add('d-none');
    loginMessage.textContent = '';
  }
  
  // Tìm user
  const user = users.find(u => u.username === username && u.password === password);
  
  if (user) {
    // Đăng nhập thành công
    loginUser(user, remember);
    
    // Đóng modal
    const modalElement = document.getElementById('loginModal');
    if (modalElement) {
      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) {
        modal.hide();
      }
    }
    
    // Hiển thị thông báo thành công
    showToast(`👋 Chào mừng ${user.fullname || user.username}`, 'success');
    
  } else {
    // Hiển thị lỗi
    if (loginMessage) {
      loginMessage.textContent = 'Tên đăng nhập hoặc mật khẩu không đúng!';
      loginMessage.classList.remove('d-none');
      loginMessage.className = 'alert alert-danger';
    }
  }
}
// Đăng nhập user
function loginUser(user, remember = false) {
  currentUser = user;
  
  // Lưu đăng nhập nếu chọn "ghi nhớ"
  if (remember) {
    localStorage.setItem('riv_current_user', JSON.stringify({
      username: user.username,
      password: user.password
    }));
  }
  
  updateLoginUI();
  showToast(`👋 Chào mừng ${user.fullname || user.username}`, 'success');
}

// Đăng xuất
function logout() {
  // Ẩn dropdown trước
  hideUserMenu();
  
  // Xóa thông tin đăng nhập
  currentUser = null;
  localStorage.removeItem('riv_current_user');
  
  // Cập nhật giao diện
  updateLoginUI();
  
  // Quay về bản đồ nếu đang ở trang chi tiết
  if (document.getElementById('stationDetail')?.style.display === 'block') {
    showMainDashboard();
  }
  
  // Hiển thị thông báo
  showToast('Đã đăng xuất thành công', 'info');
}

// ================================

// Hiển thị menu user
function toggleUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    if (dropdown.style.display === 'block') {
      dropdown.style.display = 'none';
    } else {
      // Cập nhật header của dropdown
      const header = document.getElementById('userDropdownHeader');
      if (header && currentUser) {
        header.textContent = `Xin chào, ${currentUser.fullname || currentUser.username}`;
      }
      
      // Hiển thị dropdown
      dropdown.style.display = 'block';
    }
  }
}

function toggleUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  }
}

function hideUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
}

function showAccountInfo() {
  if (!currentUser) {
    showLoginModal();
    return;
  }
  
  Swal.fire({
    title: 'Thông tin tài khoản',
    html: `
      <div class="text-start">
        <div class="mb-3 text-center">
          <div class="avatar-circle mx-auto mb-3" style="width: 70px; height: 70px; font-size: 1.5rem;">
            <span>${getInitials(currentUser.fullname || currentUser.username)}</span>
          </div>
          <h5 class="mb-1">${currentUser.fullname || currentUser.username}</h5>
          <span class="badge ${currentUser.role === 'admin' ? 'bg-danger' : 
                               currentUser.role === 'operator' ? 'bg-primary' : 'bg-success'}">
            ${currentUser.role === 'admin' ? 'Quản trị viên' : 
             currentUser.role === 'operator' ? 'Vận hành' : 'Người xem'}
          </span>
        </div>
        
        <div class="card mb-3">
          <div class="card-body p-3">
            <h6 class="card-subtitle mb-2 text-muted">Thông tin cá nhân</h6>
            <p class="mb-1"><strong>Tên đăng nhập:</strong> ${currentUser.username}</p>
            <p class="mb-1"><strong>Họ tên:</strong> ${currentUser.fullname || 'Chưa cập nhật'}</p>
            <p class="mb-0"><strong>Email:</strong> ${currentUser.email || 'Chưa cập nhật'}</p>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body p-3">
            <h6 class="card-subtitle mb-2 text-muted">Quyền truy cập</h6>
            <p class="mb-1"><strong>Trạm được xem:</strong> 
              ${currentUser.stations === 'all' ? 'Tất cả trạm' : 
                currentUser.stations && currentUser.stations.length > 0 ? 
                `Trạm ${currentUser.stations.join(', ')}` : 'Không có'}</p>
            <p class="mb-0"><strong>Quyền hạn:</strong> ${getPermissionsText(currentUser.permissions)}</p>
          </div>
        </div>
      </div>
    `,
    width: 500,
    showCloseButton: true,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: 'Đóng'
  });
}

function showAccountManager() {
  if (!currentUser) {
    showLoginModal();
    return;
  }
  
  if (currentUser.role !== 'admin') {
    showToast('Chỉ quản trị viên mới có quyền truy cập!', 'error');
    return;
  }
  
  hideUserMenu();
  
  const modal = new bootstrap.Modal(document.getElementById('accountManagerModal'));
  modal.show();
  
  // Load dữ liệu khi modal hiển thị
  const modalElement = document.getElementById('accountManagerModal');
  if (modalElement) {
    modalElement.addEventListener('shown.bs.modal', function () {
      loadAccountsTable();
      populateAccountSelect();
      populateStationsChecklist();
      populatePermissionsStations();
    });
  }
}

function loadAccountsTable() {
  const tbody = document.getElementById('accountsTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  users.forEach(user => {
    // Không hiển thị tài khoản đang đăng nhập
    if (user.username === currentUser.username) return;
    
    const roleText = user.role === 'admin' ? 'Quản trị viên' :
                     user.role === 'operator' ? 'Vận hành' : 'Người xem';
    
    const row = `
      <tr>
        <td>
          <div class="d-flex align-items-center">
            <div class="avatar-circle me-2" style="width: 30px; height: 30px; font-size: 0.8rem;">
              ${getInitials(user.fullname || user.username)}
            </div>
            <strong>${user.username}</strong>
          </div>
        </td>
        <td>${user.fullname || '—'}</td>
        <td>
          <span class="badge ${user.role === 'admin' ? 'bg-danger' :
                           user.role === 'operator' ? 'bg-primary' : 'bg-success'}">
            ${roleText}
          </span>
        </td>
        <td>
          <span class="badge bg-success">Hoạt động</span>
        </td>
        <td>
          <button class="btn btn-sm btn-outline-primary" onclick="editAccount('${user.username}')">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger ms-1" onclick="deleteAccount('${user.username}')">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
    
    tbody.innerHTML += row;
  });
}

function loadAccountPermissions() {
  const select = document.getElementById('selectAccountForPermissions');
  const container = document.getElementById('permissionsContent');
  const permissionsList = document.getElementById('permissionStationsList');
  
  if (!select || !container || !permissionsList) return;
  
  const username = select.value;
  if (!username) {
    container.style.display = 'none';
    return;
  }
  
  const user = users.find(u => u.username === username);
  if (!user) {
    container.style.display = 'none';
    return;
  }
  
  // Hiển thị container
  container.style.display = 'block';
  
  // Reset tất cả checkbox
  const permissionChecks = document.querySelectorAll('.permission-check');
  permissionChecks.forEach(cb => {
    cb.checked = false;
  });
  
  const stationChecks = permissionsList.querySelectorAll('.permission-station');
  stationChecks.forEach(cb => {
    cb.checked = false;
  });
  
  // Điền quyền
  if (user.permissions) {
    if (user.permissions === 'all') {
      permissionChecks.forEach(cb => {
        cb.checked = true;
      });
    } else if (Array.isArray(user.permissions)) {
      user.permissions.forEach(perm => {
        const cb = document.querySelector(`.permission-check[data-perm="${perm}"]`);
        if (cb) cb.checked = true;
      });
    }
  }
  
  // Điền trạm
  if (user.stations) {
    if (user.stations === 'all') {
      stationChecks.forEach(cb => {
        cb.checked = true;
      });
    } else if (Array.isArray(user.stations)) {
      user.stations.forEach(stationId => {
        const cb = document.getElementById(`permStation${stationId}`);
        if (cb) cb.checked = true;
      });
    }
  }
}

// ===== LƯU QUYỀN TÀI KHOẢN =====
function saveAccountPermissions() {
  const select = document.getElementById('selectAccountForPermissions');
  if (!select || !select.value) {
    showToast('Vui lòng chọn tài khoản!', 'error');
    return;
  }
  
  const username = select.value;
  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex === -1) return;
  
  // Lấy quyền đã chọn
  const permissions = [];
  document.querySelectorAll('.permission-check:checked').forEach(cb => {
    permissions.push(cb.getAttribute('data-perm'));
  });
  
  // Lấy trạm đã chọn
  const selectedStations = [];
  document.querySelectorAll('.permission-station:checked').forEach(cb => {
    selectedStations.push(parseInt(cb.value));
  });
  
  // Cập nhật user
  users[userIndex].permissions = permissions;
  users[userIndex].stations = selectedStations.length === stations.length ? 'all' : selectedStations;
  
  // Lưu vào localStorage
  localStorage.setItem('riv_users', JSON.stringify(users));
  
  showToast('Đã lưu phân quyền thành công!', 'success');
}

// ===== TẠO TÀI KHOẢN MỚI =====
document.addEventListener('DOMContentLoaded', function() {
  const createAccountForm = document.getElementById('createAccountForm');
  if (createAccountForm) {
    createAccountForm.addEventListener('submit', function(e) {
      e.preventDefault();
      createNewAccount();
    });
  }
});

function createNewAccount() {
  const username = document.getElementById('newAccountUsername').value.trim();
  const password = document.getElementById('newAccountPassword').value;
  const fullname = document.getElementById('newAccountFullname').value.trim();
  const email = document.getElementById('newAccountEmail').value.trim();
  const role = document.getElementById('newAccountRole').value;
  const messageEl = document.getElementById('createAccountMessage');
  
  // Reset message
  if (messageEl) {
    messageEl.classList.add('d-none');
    messageEl.textContent = '';
  }
  
  // Validate
  if (!username) {
    showFormMessage(messageEl, 'Vui lòng nhập tên đăng nhập!', 'danger');
    return;
  }
  
  if (users.some(u => u.username === username)) {
    showFormMessage(messageEl, 'Tên đăng nhập đã tồn tại!', 'danger');
    return;
  }
  
  if (!password) {
    showFormMessage(messageEl, 'Vui lòng nhập mật khẩu!', 'danger');
    return;
  }
  
  // Lấy trạm đã chọn
  const selectedStations = [];
  document.querySelectorAll('#stationsChecklist .station-checkbox:checked').forEach(cb => {
    selectedStations.push(parseInt(cb.value));
  });
  
  // Tạo tài khoản mới
  const newUser = {
    id: users.length + 1,
    username: username,
    password: password,
    fullname: fullname || username,
    email: email || '',
    role: role,
    permissions: role === 'admin' ? 'all' : ['view'],
    stations: selectedStations.length === stations.length || role === 'admin' ? 'all' : selectedStations
  };
  
  // Thêm vào danh sách
  users.push(newUser);
  localStorage.setItem('riv_users', JSON.stringify(users));
  
  // Reset form
  document.getElementById('createAccountForm').reset();
  
  // Cập nhật bảng
  loadAccountsTable();
  populateAccountSelect();
  
  showFormMessage(messageEl, 'Tạo tài khoản thành công!', 'success');
}


// ===== SỬA TÀI KHOẢN =====
function editAccount(username) {
  const user = users.find(u => u.username === username);
  if (!user) return;
  
  Swal.fire({
    title: 'Chỉnh sửa tài khoản',
    html: `
      <form id="editAccountForm">
        <div class="mb-3">
          <label class="form-label">Tên đăng nhập</label>
          <input type="text" class="form-control" value="${user.username}" readonly>
        </div>
        <div class="mb-3">
          <label class="form-label">Họ tên</label>
          <input type="text" id="editFullname" class="form-control" value="${user.fullname || ''}">
        </div>
        <div class="mb-3">
          <label class="form-label">Email</label>
          <input type="email" id="editEmail" class="form-control" value="${user.email || ''}">
        </div>
        <div class="mb-3">
          <label class="form-label">Vai trò</label>
          <select class="form-select" id="editRole">
            <option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>Người xem</option>
            <option value="operator" ${user.role === 'operator' ? 'selected' : ''}>Vận hành</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Quản trị viên</option>
          </select>
        </div>
        <div class="mb-3">
          <label class="form-label">Đặt lại mật khẩu (để trống nếu không đổi)</label>
          <input type="password" id="editPassword" class="form-control" placeholder="Mật khẩu mới">
        </div>
      </form>
    `,
    width: 500,
    showCloseButton: true,
    showCancelButton: true,
    confirmButtonText: 'Lưu thay đổi',
    cancelButtonText: 'Hủy',
    preConfirm: () => {
      const fullname = document.getElementById('editFullname').value;
      const email = document.getElementById('editEmail').value;
      const role = document.getElementById('editRole').value;
      const password = document.getElementById('editPassword').value;
      
      return { fullname, email, role, password };
    }
  }).then((result) => {
    if (result.isConfirmed && result.value) {
      const userIndex = users.findIndex(u => u.username === username);
      if (userIndex !== -1) {
        // Cập nhật thông tin
        users[userIndex].fullname = result.value.fullname;
        users[userIndex].email = result.value.email;
        users[userIndex].role = result.value.role;
        
        // Cập nhật mật khẩu nếu có
        if (result.value.password) {
          users[userIndex].password = result.value.password;
        }
        
        // Cập nhật permissions theo role
        if (result.value.role === 'admin') {
          users[userIndex].permissions = 'all';
          users[userIndex].stations = 'all';
        } else if (result.value.role === 'operator') {
          users[userIndex].permissions = ['view', 'export', 'config'];
        } else {
          users[userIndex].permissions = ['view'];
        }
        
        // Lưu vào localStorage
        localStorage.setItem('riv_users', JSON.stringify(users));
        
        // Cập nhật bảng
        loadAccountsTable();
        populateAccountSelect();
        
        showToast('Đã cập nhật tài khoản thành công!', 'success');
      }
    }
  });
}

// ===== XÓA TÀI KHOẢN =====
function deleteAccount(username) {
  if (username === currentUser.username) {
    showToast('Không thể xóa tài khoản đang đăng nhập!', 'error');
    return;
  }
  
  Swal.fire({
    title: 'Xóa tài khoản?',
    text: `Bạn có chắc chắn muốn xóa tài khoản "${username}"?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Xóa',
    cancelButtonText: 'Hủy',
    confirmButtonColor: '#d33',
    cancelButtonColor: '#3085d6'
  }).then((result) => {
    if (result.isConfirmed) {
      const userIndex = users.findIndex(u => u.username === username);
      if (userIndex !== -1) {
        users.splice(userIndex, 1);
        localStorage.setItem('riv_users', JSON.stringify(users));
        
        // Cập nhật bảng
        loadAccountsTable();
        populateAccountSelect();
        
        showToast('Đã xóa tài khoản thành công!', 'success');
      }
    }
  });
}

// ===== YÊU CẦU RESET MẬT KHẨU =====
function requestPasswordReset() {
  const username = document.getElementById('forgotUsername').value.trim();
  const email = document.getElementById('forgotEmail').value.trim();
  const messageEl = document.getElementById('forgotPasswordMessage');
  
  // Reset message
  if (messageEl) {
    messageEl.classList.add('d-none');
    messageEl.textContent = '';
  }
  
  if (!username || !email) {
    showFormMessage(messageEl, 'Vui lòng điền đầy đủ thông tin!', 'danger');
    return;
  }
  
  // Tìm user
  const user = users.find(u => u.username === username && u.email === email);
  if (!user) {
    showFormMessage(messageEl, 'Không tìm thấy tài khoản với thông tin cung cấp!', 'danger');
    return;
  }
  
  // Đặt lại mật khẩu mặc định
  user.password = '123456';
  localStorage.setItem('riv_users', JSON.stringify(users));
  
  // Đóng modal
  const modal = bootstrap.Modal.getInstance(document.getElementById('forgotPasswordModal'));
  if (modal) modal.hide();
  
  showToast('Mật khẩu đã được đặt lại về mặc định: 123456', 'success');
}

// ===== HÀM PHỤ TRỢ =====
function showFormMessage(element, message, type) {
  if (!element) return;
  
  element.textContent = message;
  element.classList.remove('d-none');
  element.className = `alert alert-${type}`;
}

function getPermissionsText(permissions) {
  if (!permissions) return 'Không có';
  if (permissions === 'all') return 'Toàn quyền';
  
  const permissionMap = {
    'view': 'Xem dữ liệu',
    'export': 'Xuất dữ liệu',
    'config': 'Cấu hình',
    'manage': 'Quản lý'
  };
  
  if (Array.isArray(permissions)) {
    return permissions.map(p => permissionMap[p] || p).join(', ');
  }
  
  return 'Không xác định';
}


// Ẩn menu user
function hideUserMenu() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
}

// Hiển thị thông tin tài khoản
function showAccountInfo() {
  Swal.fire({
    title: 'Thông tin tài khoản',
    html: `
      <div class="text-start">
        <table class="table table-borderless">
          <tr>
            <td width="40%"><strong>Tên đăng nhập:</strong></td>
            <td>${currentUser.username}</td>
          </tr>
          <tr>
            <td><strong>Họ tên:</strong></td>
            <td>${currentUser.fullname || 'Chưa cập nhật'}</td>
          </tr>
          <tr>
            <td><strong>Email:</strong></td>
            <td>${currentUser.email || 'Chưa cập nhật'}</td>
          </tr>
          <tr>
            <td><strong>Vai trò:</strong></td>
            <td>
              <span class="badge ${currentUser.role === 'admin' ? 'bg-danger' : 
                                 currentUser.role === 'operator' ? 'bg-primary' : 'bg-success'}">
                ${currentUser.role === 'admin' ? 'Quản trị viên' : 
                 currentUser.role === 'operator' ? 'Vận hành' : 'Người xem'}
              </span>
            </td>
          </tr>
          <tr>
            <td><strong>Quyền hạn:</strong></td>
            <td>${getPermissionsText(currentUser.permissions)}</td>
          </tr>
          <tr>
            <td><strong>Trạm được xem:</strong></td>
            <td>${currentUser.stations === 'all' ? 'Tất cả trạm' : `Trạm ${currentUser.stations.join(', ')}`}</td>
          </tr>
        </table>
      </div>
    `,
    icon: 'info',
    confirmButtonText: 'Đóng'
  });
}

// Hiển thị text quyền hạn
function getPermissionsText(permissions) {
  if (permissions === 'all') return 'Toàn quyền';
  
  const permissionMap = {
    'view': 'Xem dữ liệu',
    'export': 'Xuất dữ liệu',
    'config': 'Cấu hình',
    'manage': 'Quản lý'
  };
  
  return permissions.map(p => permissionMap[p] || p).join(', ');
}



function changePassword() {
  if (!currentUser) {
    showLoginModal();
    return;
  }
  
  Swal.fire({
    title: 'Đổi mật khẩu',
    html: `
      <form id="changePasswordForm">
        <div class="mb-3">
          <label class="form-label">Mật khẩu hiện tại</label>
          <input type="password" id="currentPassword" class="form-control" required>
        </div>
        <div class="mb-3">
          <label class="form-label">Mật khẩu mới</label>
          <input type="password" id="newPassword" class="form-control" minlength="6" required>
          <small class="form-text text-muted">Mật khẩu phải có ít nhất 6 ký tự</small>
        </div>
        <div class="mb-3">
          <label class="form-label">Xác nhận mật khẩu mới</label>
          <input type="password" id="confirmPassword" class="form-control" minlength="6" required>
        </div>
        <div id="passwordError" class="alert alert-danger d-none" role="alert"></div>
      </form>
    `,
    width: 500,
    showCloseButton: true,
    showCancelButton: true,
    confirmButtonText: 'Đổi mật khẩu',
    cancelButtonText: 'Hủy',
    preConfirm: () => {
      // Lấy đúng popup hiện tại
      const popup = Swal.getPopup();
      if (!popup) return false;
      
      const currentPassword = popup.querySelector('#currentPassword').value;
      const newPassword = popup.querySelector('#newPassword').value;
      const confirmPassword = popup.querySelector('#confirmPassword').value;
      const errorEl = popup.querySelector('#passwordError');
      
      // Reset lỗi
      if (errorEl) {
        errorEl.classList.add('d-none');
        errorEl.textContent = '';
      }
      
      // Tìm user thật trong mảng users
      const realUser = users.find(u => u.username === currentUser.username);
      if (!realUser) {
        if (errorEl) {
          errorEl.textContent = 'Không tìm thấy thông tin tài khoản!';
          errorEl.classList.remove('d-none');
        }
        return false;
      }
      
      // Kiểm tra mật khẩu hiện tại
      if (currentPassword !== realUser.password) {
        if (errorEl) {
          errorEl.textContent = 'Mật khẩu hiện tại không đúng!';
          errorEl.classList.remove('d-none');
        }
        return false;
      }
      
      // Kiểm tra mật khẩu mới
      if (newPassword.length < 6) {
        if (errorEl) {
          errorEl.textContent = 'Mật khẩu mới phải có ít nhất 6 ký tự!';
          errorEl.classList.remove('d-none');
        }
        return false;
      }
      
      if (newPassword !== confirmPassword) {
        if (errorEl) {
          errorEl.textContent = 'Mật khẩu xác nhận không khớp!';
          errorEl.classList.remove('d-none');
        }
        return false;
      }
      
      return { newPassword };
    }
  }).then((result) => {
    if (result.isConfirmed && result.value) {
      const userIndex = users.findIndex(u => u.username === currentUser.username);
      if (userIndex !== -1) {
        users[userIndex].password = result.value.newPassword;
        localStorage.setItem('riv_users', JSON.stringify(users));
        
        if (currentUser.password) currentUser.password = result.value.newPassword;
        
        const savedUser = localStorage.getItem('riv_current_user');
        if (savedUser) {
          const userData = JSON.parse(savedUser);
          if (userData.username === currentUser.username) {
            userData.password = result.value.newPassword;
            localStorage.setItem('riv_current_user', JSON.stringify(userData));
          }
        }
        
        if (typeof hideUserMenu === 'function') hideUserMenu();
        if (typeof showToast === 'function') showToast('Đổi mật khẩu thành công!', 'success');
      }
    }
  });
}

function populateAccountSelect() {
  const select = document.getElementById('selectAccountForPermissions');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- Chọn tài khoản --</option>';
  
  users.forEach(user => {
    // Không cho chọn tài khoản đang đăng nhập
    if (user.username === currentUser.username) return;
    
    const option = document.createElement('option');
    option.value = user.username;
    option.textContent = `${user.username} (${user.fullname || 'Chưa có tên'})`;
    select.appendChild(option);
  });
}

function populateStationsChecklist() {
  const container = document.getElementById('stationsChecklist');
  if (!container) return;
  
  container.innerHTML = '';
  
  stations.forEach(station => {
    const div = document.createElement('div');
    div.className = 'form-check form-check-inline';
    div.innerHTML = `
      <input class="form-check-input station-checkbox" type="checkbox" 
             id="station${station.id}" value="${station.id}">
      <label class="form-check-label" for="station${station.id}">
        ${station.name}
      </label>
    `;
    container.appendChild(div);
  });
  
  // Xử lý chọn tất cả
  const selectAll = document.getElementById('selectAllStations');
  if (selectAll) {
    selectAll.addEventListener('change', function() {
      const checkboxes = container.querySelectorAll('.station-checkbox');
      checkboxes.forEach(cb => {
        cb.checked = this.checked;
      });
    });
  }
}

function populatePermissionsStations() {
  const container = document.getElementById('permissionStationsList');
  if (!container) return;
  
  container.innerHTML = '';
  
  stations.forEach(station => {
    const div = document.createElement('div');
    div.className = 'form-check';
    div.innerHTML = `
      <input class="form-check-input permission-station" type="checkbox" 
             id="permStation${station.id}" value="${station.id}">
      <label class="form-check-label" for="permStation${station.id}">
        ${station.name}
      </label>
    `;
    container.appendChild(div);
  });
}

// Quản lý người dùng (chỉ admin)
function showUserManager() {
  // Code quản lý người dùng (giữ từ code trước)
  // ... (giữ nguyên phần quản lý user từ code trước)
}

// Cập nhật quyền truy cập cho user
function updateUserPermissions() {
  if (!currentUser) return;
  
  // Kiểm tra xem user có quyền xem tất cả trạm không
  if (currentUser.stations !== 'all') {
    // Ẩn các trạm không được phép xem
    stations.forEach((station, index) => {
      if (!currentUser.stations.includes(station.id)) {
        const marker = stationMarkers[station.id];
        if (marker) {
          marker.remove();
        }
      }
    });
  }
}

// Ẩn các chức năng cần đăng nhập khi chưa đăng nhập
function hideFeaturesRequiringLogin() {
  // Các nút trong header sẽ bị vô hiệu hóa
  const features = [
    'changeWifiBtn', // WiFi config
    'exportCSV' // CSV export
  ];
  
  features.forEach(feature => {
    const element = document.getElementById(feature) || 
                   document.querySelector(`[onclick*="${feature}"]`);
    if (element) {
      element.style.opacity = '0.5';
      element.style.cursor = 'not-allowed';
      element.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        showLoginModal();
        return false;
      };
    }
  });
}

// Kiểm tra đăng nhập trước khi xem chi tiết trạm
function requireLoginForStationDetail() {
  if (!currentUser) {
    showLoginModal();
    return false;
  }
  return true;
}


// ========== CÀI ĐẶT HỆ THỐNG ==========
// ========== CÀI ĐẶT HỆ THỐNG ==========


let settings = {
  general: { systemName: 'RRIV - Hệ thống giám sát trạm', language: 'vi', timezone: 'Asia/Ho_Chi_Minh', refreshInterval: 30, theme: 'light' },
  stations: { phMin: 5.5, phMax: 8.5, humMin: 20, humMax: 80, tempMin: 15, tempMax: 40, ecMin: 4, ecMax: 19, batteryAlert: 20 },
  weather: { apiKey: '90c9425ec2db6451d70d2e49a1af5adc', units: 'metric', interval: 30 },
  datasource: {
    mode: 'manual',   // thêm dòng này
    api: {            // thêm toàn bộ object api
      url: '',
      method: 'GET',
      headers: {},
      interval: 30
    },
    push: {
      enabled: false,
      url: '',
      method: 'POST',
      headers: {},
      interval: 30,
      payloadTemplate: ''   // nếu cần thì thêm luôn
    }
  }
};

let globalRefreshTimer = null; // Khai báo biến timer toàn cục


function updateSystemNameUI() {
  const systemName = settings.general.systemName || 'RRIV';
  // Cập nhật tiêu đề trình duyệt
  document.title = `${systemName} - Bản đồ trạm`;
  // Cập nhật tên hiển thị trong header (nếu có)
  const deviceNameSpan = document.querySelector('.device-name');
  if (deviceNameSpan) {
    deviceNameSpan.textContent = systemName;
  }
  // Có thể cập nhật thêm ở footer hoặc các nơi khác
  const footerText = document.querySelector('footer .footer-text');
  if (footerText) footerText.textContent = systemName;
}

function loadSettingsToForm() {
  // General
  if (document.getElementById('systemName')) document.getElementById('systemName').value = settings.general.systemName;
  if (document.getElementById('language')) document.getElementById('language').value = settings.general.language;
  if (document.getElementById('timezone')) document.getElementById('timezone').value = settings.general.timezone;
  if (document.getElementById('refreshIntervalGlobal')) document.getElementById('refreshIntervalGlobal').value = settings.general.refreshInterval;
  if (settings.general.theme === 'dark') document.getElementById('darkTheme').checked = true;
  else if (document.getElementById('lightTheme')) document.getElementById('lightTheme').checked = true;

  // Stations thresholds
  if (document.getElementById('phMin')) document.getElementById('phMin').value = settings.stations.phMin;
  if (document.getElementById('phMax')) document.getElementById('phMax').value = settings.stations.phMax;
  if (document.getElementById('humMin')) document.getElementById('humMin').value = settings.stations.humMin;
  if (document.getElementById('humMax')) document.getElementById('humMax').value = settings.stations.humMax;
  if (document.getElementById('tempMin')) document.getElementById('tempMin').value = settings.stations.tempMin;
  if (document.getElementById('tempMax')) document.getElementById('tempMax').value = settings.stations.tempMax;
  // ĐÚNG
if (document.getElementById('ecMin')) document.getElementById('ecMin').value = settings.stations.ecMin;
if (document.getElementById('ecMax')) document.getElementById('ecMax').value = settings.stations.ecMax;
  if (document.getElementById('batteryAlert')) document.getElementById('batteryAlert').value = settings.stations.batteryAlert;

  // Weather
  if (document.getElementById('weatherApiKey')) document.getElementById('weatherApiKey').value = settings.weather.apiKey;
  if (document.getElementById('weatherUnits')) document.getElementById('weatherUnits').value = settings.weather.units;
  if (document.getElementById('weatherInterval')) document.getElementById('weatherInterval').value = settings.weather.interval;

  // Data source - Push config (MỚI)
  if (document.getElementById('pushServerUrl')) document.getElementById('pushServerUrl').value = settings.datasource.push.url || '';
  if (document.getElementById('pushMethod')) document.getElementById('pushMethod').value = settings.datasource.push.method || 'POST';
  if (document.getElementById('pushInterval')) document.getElementById('pushInterval').value = settings.datasource.push.interval || 30;
  if (document.getElementById('pushHeaders')) {
    try {
      document.getElementById('pushHeaders').value = JSON.stringify(settings.datasource.push.headers || {}, null, 2);
    } catch(e) {
      document.getElementById('pushHeaders').value = '{}';
    }
  }

  // Stations thresholds - kiểm tra và gán giá trị mặc định nếu undefined
  if (document.getElementById('phMin')) document.getElementById('phMin').value = settings.stations.phMin ?? 5.5;
  if (document.getElementById('phMax')) document.getElementById('phMax').value = settings.stations.phMax ?? 8.5;
  if (document.getElementById('humMin')) document.getElementById('humMin').value = settings.stations.humMin ?? 20;
  if (document.getElementById('humMax')) document.getElementById('humMax').value = settings.stations.humMax ?? 80;
  if (document.getElementById('tempMin')) document.getElementById('tempMin').value = settings.stations.tempMin ?? 15;
  if (document.getElementById('tempMax')) document.getElementById('tempMax').value = settings.stations.tempMax ?? 40;
  
  // Đặc biệt xử lý ecMin, ecMax
  if (document.getElementById('ecMin')) {
    let val = settings.stations.ecMin;
    if (val === undefined || isNaN(val)) val = 0.5;
    document.getElementById('ecMin').value = val;
  }
  if (document.getElementById('ecMax')) {
    let val = settings.stations.ecMax;
    if (val === undefined || isNaN(val)) val = 5.0;
    document.getElementById('ecMax').value = val;
  }
  
  if (document.getElementById('batteryAlert')) document.getElementById('batteryAlert').value = settings.stations.batteryAlert ?? 20;

  renderStationsSettingsList();
}



function saveAllSettings() {
  //alert('🔧 Hàm saveAllSettings đã được gọi!');  // Kiểm tra xem có nhảy alert không

  try {
    // ----- GENERAL -----
    if (document.getElementById('systemName')) settings.general.systemName = document.getElementById('systemName').value;
    if (document.getElementById('language')) settings.general.language = document.getElementById('language').value;
    if (document.getElementById('timezone')) settings.general.timezone = document.getElementById('timezone').value;
    let refreshVal = parseInt(document.getElementById('refreshIntervalGlobal')?.value);
    settings.general.refreshInterval = isNaN(refreshVal) ? 30 : refreshVal;
    settings.general.theme = document.getElementById('darkTheme')?.checked ? 'dark' : 'light';

    // ----- THRESHOLDS -----
    let phMin = parseFloat(document.getElementById('phMin')?.value);
    settings.stations.phMin = isNaN(phMin) ? 5.5 : phMin;
    let phMax = parseFloat(document.getElementById('phMax')?.value);
    settings.stations.phMax = isNaN(phMax) ? 8.5 : phMax;
    let humMin = parseInt(document.getElementById('humMin')?.value);
    settings.stations.humMin = isNaN(humMin) ? 20 : humMin;
    let humMax = parseInt(document.getElementById('humMax')?.value);
    settings.stations.humMax = isNaN(humMax) ? 80 : humMax;
    let tempMin = parseFloat(document.getElementById('tempMin')?.value);
    settings.stations.tempMin = isNaN(tempMin) ? 15 : tempMin;
    let tempMax = parseFloat(document.getElementById('tempMax')?.value);
    settings.stations.tempMax = isNaN(tempMax) ? 40 : tempMax;
    let ecMin = parseFloat(document.getElementById('ecMin')?.value);
    settings.stations.ecMin = isNaN(ecMin) ? 0.5 : ecMin;
    let ecMax = parseFloat(document.getElementById('ecMax')?.value);
    settings.stations.ecMax = isNaN(ecMax) ? 5.0 : ecMax;
    let batteryAlert = parseInt(document.getElementById('batteryAlert')?.value);
    settings.stations.batteryAlert = isNaN(batteryAlert) ? 20 : batteryAlert;

    // ----- WEATHER -----
    if (document.getElementById('weatherApiKey')) settings.weather.apiKey = document.getElementById('weatherApiKey').value;
    if (document.getElementById('weatherUnits')) settings.weather.units = document.getElementById('weatherUnits').value;
    let weatherInt = parseInt(document.getElementById('weatherInterval')?.value);
    settings.weather.interval = isNaN(weatherInt) ? 30 : weatherInt;

    // ----- DATA SOURCE -----
    if (document.getElementById('dataSourceMode')) settings.datasource.mode = document.getElementById('dataSourceMode').value;
    if (document.getElementById('apiUrl')) settings.datasource.api.url = document.getElementById('apiUrl').value;
    if (document.getElementById('apiMethod')) settings.datasource.api.method = document.getElementById('apiMethod').value;
    try {
      if (document.getElementById('apiHeaders')) 
        settings.datasource.api.headers = JSON.parse(document.getElementById('apiHeaders').value || '{}');
    } catch(e) { console.warn('Headers API không hợp lệ'); }
    let apiInt = parseInt(document.getElementById('apiInterval')?.value);
    if (!isNaN(apiInt)) settings.datasource.api.interval = apiInt;

    if (document.getElementById('enablePushData')) 
      settings.datasource.push.enabled = document.getElementById('enablePushData').checked;
    if (document.getElementById('pushServerUrl')) 
      settings.datasource.push.url = document.getElementById('pushServerUrl').value;
    if (document.getElementById('pushMethod')) 
      settings.datasource.push.method = document.getElementById('pushMethod').value;
    let pushInt = parseInt(document.getElementById('pushInterval')?.value);
    if (!isNaN(pushInt)) settings.datasource.push.interval = pushInt;
    try {
      if (document.getElementById('pushHeaders')) 
        settings.datasource.push.headers = JSON.parse(document.getElementById('pushHeaders').value || '{}');
    } catch(e) { console.warn('Headers push không hợp lệ'); }
    if (document.getElementById('pushPayloadTemplate')) 
      settings.datasource.push.payloadTemplate = document.getElementById('pushPayloadTemplate').value;

    // Lưu xuống localStorage
    localStorage.setItem('rriv_settings', JSON.stringify(settings));
    
    // Áp dụng
    loadSettingsToForm();   // cập nhật form ngay lập tức với giá trị vừa lưu
applySettings();        // áp dụng ngưỡng mới cho cảnh báo
updateAllDisplays();    // làm mới giao diện

    // Thông báo bằng alert trước, sau đó mới dùng toast
    alert('✅ Đã lưu cài đặt thành công!');
    showToast('✅ Đã lưu cài đặt thành công!', 'success');

    // Tạm thời comment phần đồng bộ gateway để tránh lỗi
    
    saveThresholdsToGateway().then(() => {
      showToast('✅ Đã đồng bộ ngưỡng lên gateway', 'success');
    }).catch(() => {
      showToast('⚠️ Lưu local OK nhưng không đồng bộ được gateway', 'warning');
    });
    
  } catch (error) {
    console.error('Lỗi khi lưu settings:', error);
    alert('❌ Lỗi: ' + error.message);
    showToast('❌ Lỗi lưu cài đặt, xem console', 'error');
  }
}



function applySettings() {
  // Áp dụng tần suất refresh
  if (globalRefreshTimer) clearInterval(globalRefreshTimer);
  if (settings.general.refreshInterval > 0) {
    globalRefreshTimer = setInterval(() => {
      //refreshAllStationsData();
      updateAllDisplays();
    }, settings.general.refreshInterval * 1000);
  }
  // Áp dụng theme (demo)
  if (settings.general.theme === 'dark') document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');
  // Cập nhật API key thời tiết
  window.apiKey = settings.weather.apiKey;
  // Khởi động lại polling nếu cần
  restartDataPolling();
}

function restartDataPolling() {
  // Dừng polling cũ nếu có
  if (window.dataPollingTimer) clearInterval(window.dataPollingTimer);
  if (settings.datasource.mode === 'api' && settings.datasource.api.interval > 0) {
    window.dataPollingTimer = setInterval(() => {
      fetchDataFromServer();
    }, settings.datasource.api.interval * 1000);
  }
}

async function fetchDataFromServer() {
  if (settings.datasource.mode !== 'api') return;
  const url = settings.datasource.api.url;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: settings.datasource.api.method,
      headers: settings.datasource.api.headers
    });
    const data = await res.json();
    // Giả sử API trả về mảng stations với cấu trúc giống stations của bạn
    if (data && Array.isArray(data)) {
      stations = data;
      localStorage.setItem('stations', JSON.stringify(stations));
      updateAllDisplays();
    }
  } catch (err) {
    console.warn('Polling API error:', err);
  }
}

function renderStationsSettingsList() {
  const container = document.getElementById('stationsSettingsList');
  if (!container) return;
  container.innerHTML = '';
  stations.forEach((station, idx) => {
    const card = document.createElement('div');
    card.className = 'card mb-2';
    card.innerHTML = `
  <div class="card border-0 bg-light mb-2 rounded-2">
    <div class="card-body py-1 px-2">
      <div class="row g-1 align-items-center">
        <div class="col-2 col-md-1 text-truncate">
          <i class="fas fa-tower-broadcast text-success me-1"></i>
          <span class="small fw-semibold">${station.name}</span>
        </div>
        <div class="col-3 col-md-2">
          <input type="text" class="form-control form-control-sm station-name" data-id="${station.id}" value="${station.name}" placeholder="Tên mới">
        </div>
        <div class="col-3 col-md-2">
          <div class="input-group input-group-sm">
            <span class="input-group-text py-0">Lat</span>
            <input type="number" step="0.0001" class="form-control station-lat" data-id="${station.id}" value="${station.location.lat}">
          </div>
        </div>
        <div class="col-3 col-md-2">
          <div class="input-group input-group-sm">
            <span class="input-group-text py-0">Lng</span>
            <input type="number" step="0.0001" class="form-control station-lng" data-id="${station.id}" value="${station.location.lng}">
          </div>
        </div>
        
        <div class="col-2 col-md-1 text-end">
          <button class="btn btn-sm btn-outline-danger py-0 px-1 delete-station" data-id="${station.id}">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
`;
    container.appendChild(card);
  });
  // Gán sự kiện
  document.querySelectorAll('.station-name').forEach(inp => inp.addEventListener('change', (e) => {
    const station = stations.find(s => s.id == e.target.dataset.id);
    if (station) station.name = e.target.value;
    localStorage.setItem('stations', JSON.stringify(stations));
    updateAllDisplays();
  }));
  document.querySelectorAll('.station-lat, .station-lng').forEach(inp => inp.addEventListener('change', (e) => {
    const station = stations.find(s => s.id == e.target.dataset.id);
    if (station) {
      station.location.lat = parseFloat(document.querySelector(`.station-lat[data-id="${station.id}"]`).value);
      station.location.lng = parseFloat(document.querySelector(`.station-lng[data-id="${station.id}"]`).value);
      localStorage.setItem('stations', JSON.stringify(stations));
      if (map) addStationMarkers();
      updateAllDisplays();
    }
  }));
  document.querySelectorAll('.station-status').forEach(chk => chk.addEventListener('change', (e) => {
    const station = stations.find(s => s.id == e.target.dataset.id);
    if (station) station.status = e.target.checked;
    localStorage.setItem('stations', JSON.stringify(stations));
    updateAllDisplays();
  }));
  document.querySelectorAll('.delete-station').forEach(btn => btn.addEventListener('click', (e) => {
    const id = parseInt(e.target.dataset.id);
    stations = stations.filter(s => s.id !== id);
    localStorage.setItem('stations', JSON.stringify(stations));
    renderStationsSettingsList();
    updateAllDisplays();
  }));
}

function toggleApiSection() {
  const mode = document.getElementById('dataSourceMode').value;
  const apiSection = document.getElementById('apiConfigSection');
  if (apiSection) apiSection.style.display = mode === 'api' ? 'block' : 'none';
}
function togglePushSection() {
  const pushSection = document.getElementById('pushConfigSection');
  if (pushSection) pushSection.style.display = document.getElementById('enablePushData').checked ? 'block' : 'none';
}

async function testApiConnection() {
  const url = document.getElementById('apiUrl').value;
  if (!url) { showToast('Vui lòng nhập URL', 'error'); return; }
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(data);
    showToast('Kết nối thành công! Xem console.', 'success');
  } catch(err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function testPushData() {
  if (!settings.datasource.push.url) { showToast('Chưa cấu hình push URL', 'error'); return; }
  const sampleData = { id: 1, data: stations[0]?.data || [], timestamp: new Date().toISOString() };
  try {
    const res = await fetch(settings.datasource.push.url, {
      method: settings.datasource.push.method,
      headers: settings.datasource.push.headers,
      body: JSON.stringify(sampleData)
    });
    showToast('Gửi thử thành công!', 'success');
  } catch(err) { showToast('Lỗi: ' + err.message, 'error'); }
}

function exportSettings() {
  const dataStr = JSON.stringify({ settings, stations, users }, null, 2);
  const blob = new Blob([dataStr], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rriv_backup_${new Date().toISOString().slice(0,19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.settings) Object.assign(settings, data.settings);
      if (data.stations) { stations = data.stations; localStorage.setItem('stations', JSON.stringify(stations)); }
      if (data.users) { users = data.users; localStorage.setItem('riv_users', JSON.stringify(users)); }
      localStorage.setItem('rriv_settings', JSON.stringify(settings));
      loadSettingsToForm();
      applySettings();
      updateAllDisplays();
      showToast('Khôi phục thành công!', 'success');
    } catch(err) { showToast('File không hợp lệ', 'error'); }
  };
  reader.readAsText(file);
}

function resetToDefault() {
  if (confirm('Đặt lại tất cả cài đặt về mặc định? Dữ liệu trạm và tài khoản sẽ mất!')) {
    localStorage.clear();
    location.reload();
  }
}




function showSettings() {
  if (!requireLoginForStationDetail()) return;
  if (!canAccessSettings()) {
    showToast('Bạn không có quyền truy cập Cài đặt', 'error');
    return;
  }
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  document.getElementById('settingsView').style.display = 'block';
  //loadThresholdsFromGateway().then(() => {
  //  loadSettingsToForm();
  //}).catch(() => {
  //  loadSettingsToForm();
  //});
  loadAccountsTableSettings();
  populateAccountSelectSettings();
  populateStationsChecklistSettings();
  updateNavActive('settingsView');
}
// ========== CÁC HÀM CHO TAB QUẢN LÝ TÀI KHOẢN TRONG SETTINGS ==========
function loadAccountsTableSettings() {
  const tbody = document.getElementById('accountsTableBodySettings');
  if (!tbody) return;
  tbody.innerHTML = '';
  users.forEach(user => {
    if (user.username === currentUser?.username) return;
    const roleText = user.role === 'admin' ? 'Quản trị viên' : (user.role === 'operator' ? 'Vận hành' : 'Người xem');
    const row = `
      <tr>
        <td>${user.username}</td>
        <td>${user.fullname || '—'}</td>
        <td><span class="badge ${user.role === 'admin' ? 'bg-danger' : (user.role === 'operator' ? 'bg-primary' : 'bg-success')}">${roleText}</span></td>
        <td>
          <button class="btn btn-sm btn-outline-primary" onclick="editAccountSettings('${user.username}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-sm btn-outline-danger" onclick="deleteAccountSettings('${user.username}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `;
    tbody.innerHTML += row;
  });
}

function populateAccountSelectSettings() {
  const select = document.getElementById('selectAccountPerm');
  if (!select) return;
  select.innerHTML = '<option value="">-- Chọn tài khoản --</option>';
  users.forEach(user => {
    if (user.username === currentUser?.username) return;
    const option = document.createElement('option');
    option.value = user.username;
    option.textContent = `${user.username} (${user.fullname || 'chưa có tên'})`;
    select.appendChild(option);
  });
  select.onchange = () => loadAccountPermissionsSettings();
}

function populateStationsChecklistSettings() {
  const container = document.getElementById('stationsChecklistSettings');
  if (!container) return;
  container.innerHTML = '';
  stations.forEach(station => {
    const div = document.createElement('div');
    div.className = 'form-check form-check-inline';
    div.innerHTML = `
      <input class="form-check-input station-checkbox-settings" type="checkbox" id="stationSettings${station.id}" value="${station.id}">
      <label class="form-check-label" for="stationSettings${station.id}">${station.name}</label>
    `;
    container.appendChild(div);
  });
  // Chọn tất cả
  const selectAll = document.getElementById('selectAllStationsSettings');
  if (selectAll) {
    selectAll.onchange = (e) => {
      document.querySelectorAll('#stationsChecklistSettings .station-checkbox-settings').forEach(cb => cb.checked = e.target.checked);
    };
  }
}

function createAccountFromSettings(e) {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const fullname = document.getElementById('newFullname').value.trim();
  const email = document.getElementById('newEmail').value.trim();
  const role = document.getElementById('newRole').value;
  const selectedStations = Array.from(document.querySelectorAll('#stationsChecklistSettings .station-checkbox-settings:checked')).map(cb => parseInt(cb.value));
  if (!username) { showToast('Vui lòng nhập tên đăng nhập', 'error'); return; }
  if (users.some(u => u.username === username)) { showToast('Tên đăng nhập đã tồn tại', 'error'); return; }
  const newUser = {
    id: users.length + 1,
    username, password, fullname: fullname || username, email,
    role,
    permissions: role === 'admin' ? 'all' : ['view'],
    stations: selectedStations.length === stations.length || role === 'admin' ? 'all' : selectedStations
  };
  users.push(newUser);
  localStorage.setItem('riv_users', JSON.stringify(users));
  document.getElementById('createAccountFormSettings').reset();
  loadAccountsTableSettings();
  populateAccountSelectSettings();
  showToast('Tạo tài khoản thành công', 'success');
}

function editAccountSettings(username) {
  const user = users.find(u => u.username === username);
  if (!user) return;
  Swal.fire({
    title: 'Chỉnh sửa tài khoản',
    html: `
      <input id="editFullname" class="swal2-input" placeholder="Họ tên" value="${user.fullname || ''}">
      <input id="editEmail" class="swal2-input" placeholder="Email" value="${user.email || ''}">
      <select id="editRole" class="swal2-select">
        <option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>Người xem</option>
        <option value="operator" ${user.role === 'operator' ? 'selected' : ''}>Vận hành</option>
        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Quản trị viên</option>
      </select>
      <input id="editPassword" class="swal2-input" type="password" placeholder="Mật khẩu mới (bỏ trống nếu không đổi)">
    `,
    preConfirm: () => {
      const fullname = document.getElementById('editFullname').value;
      const email = document.getElementById('editEmail').value;
      const role = document.getElementById('editRole').value;
      const password = document.getElementById('editPassword').value;
      return { fullname, email, role, password };
    }
  }).then(result => {
    if (result.isConfirmed) {
      user.fullname = result.value.fullname;
      user.email = result.value.email;
      user.role = result.value.role;
      if (result.value.password) user.password = result.value.password;
      if (result.value.role === 'admin') { user.permissions = 'all'; user.stations = 'all'; }
      else if (result.value.role === 'operator') user.permissions = ['view', 'export', 'config'];
      else user.permissions = ['view'];
      localStorage.setItem('riv_users', JSON.stringify(users));
      loadAccountsTableSettings();
      populateAccountSelectSettings();
      showToast('Đã cập nhật', 'success');
    }
  });
}


function deleteAccountSettings(username) {
  // Kiểm tra currentUser
  if (!currentUser) {
      console.error("currentUser chưa được khởi tạo");
      showToast("Lỗi: chưa đăng nhập", "error");
      return;
  }
  if (username === currentUser.username) {
      showToast("Không thể xóa chính mình", "error");
      return;
  }

  Swal.fire({
      title: "Xác nhận xóa?",
      text: `Tài khoản ${username} sẽ bị mất vĩnh viễn!`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Xóa ngay"
  }).then((result) => {
      if (result.isConfirmed) {
          // Tìm index
          const index = users.findIndex(u => u.username === username);
          if (index === -1) {
              showToast("Không tìm thấy tài khoản", "error");
              return;
          }

          // Xóa
          users.splice(index, 1);
          
          // Lưu xuống localStorage
          localStorage.setItem("riv_users", JSON.stringify(users));
          
          // Cập nhật giao diện
          loadAccountsTableSettings();
          if (typeof populateAccountSelectSettings === "function") {
              populateAccountSelectSettings();
          }
          
          // Reset dropdown phân quyền nếu đang chọn tài khoản bị xóa
          const selectPerm = document.getElementById("selectAccountPerm");
          if (selectPerm && selectPerm.value === username) {
              selectPerm.value = "";
              document.getElementById("permDetails").innerHTML = "";
          }
          
          showToast("Đã xóa thành công", "success");
          
          // Debug: kiểm tra lại mảng users
          console.log("Sau khi xóa, users còn:", users.map(u => u.username));
      }
  });
}
function loadAccountPermissionsSettings() {
  const username = document.getElementById('selectAccountPerm').value;
  const container = document.getElementById('permDetails');
  if (!username) { container.innerHTML = ''; return; }
  const user = users.find(u => u.username === username);
  if (!user) return;
  let stationsHtml = '';
  stations.forEach(station => {
    const checked = (user.stations === 'all' || (Array.isArray(user.stations) && user.stations.includes(station.id))) ? 'checked' : '';
    stationsHtml += `<div class="form-check"><input class="form-check-input perm-station" type="checkbox" value="${station.id}" id="permStationSettings${station.id}" ${checked}><label class="form-check-label" for="permStationSettings${station.id}">${station.name}</label></div>`;
  });
  container.innerHTML = `
    <h6>Quyền chức năng</h6>
    <div class="row">
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permViewMap" data-perm="viewMap"> <label>Xem bản đồ</label></div></div>
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permViewCharts" data-perm="viewCharts"> <label>Xem biểu đồ</label></div></div>
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permViewWeather" data-perm="viewWeather"> <label>Xem thời tiết</label></div></div>
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permExportCSV" data-perm="exportCSV"> <label>Xuất CSV</label></div></div>
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permConfigWifi" data-perm="configWifi"> <label>Cấu hình WiFi</label></div></div>
      <div class="col-md-6"><div class="form-check"><input class="form-check-input perm-func" type="checkbox" id="permManageAccounts" data-perm="manageAccounts"> <label>Quản lý tài khoản</label></div></div>
    </div>
    <h6 class="mt-3">Trạm được phép</h6>
    <div id="permStationsList">${stationsHtml}</div>
  `;
  // Set quyền hiện tại
  const perms = (user.permissions === 'all') ? ['viewMap','viewCharts','viewWeather','exportCSV','configWifi','manageAccounts'] : (user.permissions || []);
  document.querySelectorAll('.perm-func').forEach(cb => {
    cb.checked = perms.includes(cb.dataset.perm);
  });
}

function saveAccountPermissionsSettings() {
  const username = document.getElementById('selectAccountPerm').value;
  if (!username) { showToast('Chọn tài khoản', 'error'); return; }
  const user = users.find(u => u.username === username);
  if (!user) return;
  const selectedFuncs = Array.from(document.querySelectorAll('.perm-func:checked')).map(cb => cb.dataset.perm);
  const selectedStations = Array.from(document.querySelectorAll('.perm-station:checked')).map(cb => parseInt(cb.value));
  user.permissions = selectedFuncs;
  user.stations = selectedStations.length === stations.length ? 'all' : selectedStations;
  localStorage.setItem('riv_users', JSON.stringify(users));
  showToast('Đã lưu phân quyền', 'success');
}

// Gắn sự kiện cho form tạo tài khoản trong settings
document.addEventListener('DOMContentLoaded', () => {
  const createForm = document.getElementById('createAccountFormSettings');
  if (createForm) createForm.addEventListener('submit', createAccountFromSettings);
  const savePermBtn = document.getElementById('savePermBtn');
  if (savePermBtn) savePermBtn.addEventListener('click', saveAccountPermissionsSettings);
  document.getElementById('savePushConfigBtn')?.addEventListener('click', savePushConfiguration);
document.getElementById('testPushNowBtn')?.addEventListener('click', testPushNow);
  // Các nút khác
  document.getElementById('saveAllSettingsBtn')?.addEventListener('click', saveAllSettings);
  document.getElementById('testApiBtn')?.addEventListener('click', testApiConnection);
  document.getElementById('testPushBtn')?.addEventListener('click', testPushData);
  document.getElementById('exportSettingsBtn')?.addEventListener('click', exportSettings);
  document.getElementById('importSettingsBtn')?.addEventListener('click', () => {
    const file = document.getElementById('importSettingsFile').files[0];
    if (file) importSettings(file);
  });
  document.getElementById('resetToDefaultBtn')?.addEventListener('click', resetToDefault);
  document.getElementById('dataSourceMode')?.addEventListener('change', toggleApiSection);
  document.getElementById('enablePushData')?.addEventListener('change', togglePushSection);
  document.getElementById('testWeatherApiBtn')?.addEventListener('click', testWeatherApi);
});

async function testWeatherApi() {
  const key = document.getElementById('weatherApiKey').value;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=Hanoi&appid=${key}&units=metric`;
  try {
    const res = await fetch(url);
    if (res.ok) showToast('API Key hợp lệ', 'success');
    else showToast('API Key không hợp lệ', 'error');
  } catch(e) { showToast('Lỗi kết nối', 'error'); }
}

// Hàm gộp object (deep merge)
function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}


function initSettings() {
  // Định nghĩa default settings (giá trị mặc định)
  const defaultSettings = {
    general: {
      systemName: 'RRIV - Hệ thống giám sát trạm',
      language: 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
      refreshInterval: 30,
      theme: 'light'
    },
    stations: {
      phMin: 5.5,
      phMax: 8.5,
      humMin: 20,
      humMax: 80,
      tempMin: 15,
      tempMax: 40,
      ecMin: 4,
      ecMax: 19,          // ← giá trị mặc định đúng với HTML
      batteryAlert: 20
    },
    weather: {
      apiKey: '90c9425ec2db6451d70d2e49a1af5adc',
      units: 'metric',
      interval: 30
    },
    datasource: {
      mode: 'manual',
      api: { url: '', method: 'GET', headers: {}, interval: 30 },
      push: { enabled: false, url: '', method: 'POST', headers: {}, interval: 30, payloadTemplate: '' }
    }
  };

  // Đọc từ localStorage
  const saved = localStorage.getItem('rriv_settings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // Gộp thủ công: ưu tiên dữ liệu đã lưu, nếu thiếu trường thì lấy default
      settings = {
        general: { ...defaultSettings.general, ...parsed.general },
        stations: { ...defaultSettings.stations, ...parsed.stations },
        weather: { ...defaultSettings.weather, ...parsed.weather },
        datasource: { ...defaultSettings.datasource, ...parsed.datasource }
      };
      // Đảm bảo ecMin/ecMax có giá trị hợp lý (tránh NaN)
      if (isNaN(settings.stations.ecMin)) settings.stations.ecMin = defaultSettings.stations.ecMin;
      if (isNaN(settings.stations.ecMax)) settings.stations.ecMax = defaultSettings.stations.ecMax;
    } catch (e) {
      console.error('Lỗi parse settings:', e);
      settings = defaultSettings;
    }
  } else {
    settings = defaultSettings;
  }

  // Lưu lại để đồng bộ (nếu có thiếu hụt)
  localStorage.setItem('rriv_settings', JSON.stringify(settings));

  // Cập nhật form và áp dụng
  loadSettingsToForm();
  applySettings();
}

function savePushConfiguration() {
  const url = document.getElementById('pushServerUrl').value.trim();
  const method = document.getElementById('pushMethod').value;
  const interval = parseInt(document.getElementById('pushInterval').value);
  let headers = {};
  try {
    headers = JSON.parse(document.getElementById('pushHeaders').value || '{}');
  } catch(e) {
    showToast('Headers không đúng định dạng JSON', 'error');
    return;
  }

  // Lưu vào settings
  settings.datasource.push = {
    enabled: (url !== ''),
    url: url,
    method: method,
    headers: headers,
    interval: interval
  };
  localStorage.setItem('rriv_settings', JSON.stringify(settings));

  // (Tuỳ chọn) Dừng timer cũ và khởi động lại nếu có url
  if (pushDataTimer) clearInterval(pushDataTimer);
  if (url && interval > 0) {
    startPushDataTimer();
  }

  showToast('✅ Đã lưu cấu hình gửi dữ liệu', 'success');
  document.getElementById('pushConfigMessage').innerHTML = '<div class="alert alert-success">Cấu hình đã được lưu. Getway sẽ tự động gửi dữ liệu.</div>';
  setTimeout(() => {
    const msgDiv = document.getElementById('pushConfigMessage');
    if (msgDiv) msgDiv.innerHTML = '';
  }, 3000);
}

async function testPushNow() {
  const url = document.getElementById('pushServerUrl').value.trim();
  if (!url) {
    showToast('Vui lòng nhập URL server đích', 'error');
    return;
  }
  const method = document.getElementById('pushMethod').value;
  let headers = {};
  try {
    headers = JSON.parse(document.getElementById('pushHeaders').value || '{}');
  } catch(e) {
    showToast('Headers không đúng JSON', 'error');
    return;
  }

  // Lấy dữ liệu từ trạm đầu tiên làm mẫu
  if (!stations || stations.length === 0) {
    showToast('Chưa có dữ liệu trạm', 'error');
    return;
  }
  const sampleStation = stations[0];
  const payload = buildPushPayload(sampleStation);

  try {
    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: method === 'POST' ? JSON.stringify(payload) : undefined
    });
    if (response.ok) {
      showToast('✅ Gửi thử thành công!', 'success');
    } else {
      showToast(`❌ Lỗi: ${response.status} ${response.statusText}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Không thể kết nối: ${err.message}`, 'error');
  }
}

function buildPushPayload(station) {
  const data = station.data;
  return {
    station_id: station.id,
    station_name: station.name,
    timestamp: new Date().toISOString(),
    ph: data[0],
    vwc: data[1],          //  Hàm lượng nước (VWC) thể tích (%)
    ec: data[2],           //  dS/m
    temperature: data[3],  // °C
    red: data[4],          // W/m²
    nir: data[5],          // W/m²
    battery: data[7],      // %
    charging: data[8],
    voltage: data[9]
  };
}

async function sendAllStationsDataToServer() {
  const pushCfg = settings.datasource.push;
  if (!pushCfg.enabled || !pushCfg.url) return;

  for (const station of stations) {
    const payload = buildPushPayload(station);
    try {
      const response = await fetch(pushCfg.url, {
        method: pushCfg.method,
        headers: pushCfg.headers,
        body: pushCfg.method === 'POST' ? JSON.stringify(payload) : undefined
      });
      if (!response.ok) {
        console.warn(`Gửi dữ liệu trạm ${station.id} thất bại: ${response.status}`);
      }
    } catch (err) {
      console.error(`Lỗi gửi trạm ${station.id}:`, err);
    }
  }
}

function startPushDataTimer() {
  if (pushDataTimer) clearInterval(pushDataTimer);
  const intervalSec = settings.datasource.push.interval;
  if (intervalSec > 0) {
    pushDataTimer = setInterval(() => {
      sendAllStationsDataToServer();
    }, intervalSec * 1000);
  }
}


// ==================== CẤU HÌNH ====================
const API_KEY = 'd5f756a1e6dac5070622426ad90cfd2e'; // 🔴 Thay bằng API key của bạn
const BASE_URL = 'https://api.openweathermap.org/data/2.5/forecast';
/*
// Danh sách các trạm nông nghiệp (tên, kinh độ, vĩ độ)
const STATIONS = [
  { name: 'Trạm Hà Nội', lat: 21.0285, lon: 105.8542 },
  { name: 'Trạm Hồ Chí Minh', lat: 10.8231, lon: 106.6297 },
  { name: 'Trạm Đà Nẵng', lat: 16.0544, lon: 108.2022 },
  { name: 'Trạm Cần Thơ', lat: 10.0452, lon: 105.7469 },
  { name: 'Trạm Lâm Đồng', lat: 11.9465, lon: 108.4419 }
];
*/

function initStationSelectFromRealStations() {
  const select = document.getElementById('stationSelect');
  if (!select) return;

  // Giữ lại option "Tất cả trạm"
  select.innerHTML = '<option value="all">Tất cả trạm (vị trí trung bình)</option>';

  // Duyệt qua mảng stations (đã có dữ liệu từ gateway)
  stations.forEach((station, idx) => {
    if (station.location && typeof station.location.lat === 'number' && station.location.lng) {
      const option = document.createElement('option');
      option.value = idx;   // lưu index để tra cứu nhanh
      option.textContent = station.name;
      select.appendChild(option);
    }
  });

  select.value = 'all';
}
// ==================== KHỞI TẠO TRANG ====================
document.addEventListener('DOMContentLoaded', () => {
  initStationSelect();
  loadWeatherData(); // Tải dữ liệu mặc định (tất cả trạm, 3 ngày)
});

// Hiển thị dropdown trạm
function initStationSelect() {
  const select = document.getElementById('stationSelect');
  if (!select) return;
  select.innerHTML = '<option value="all">Tất cả trạm (vị trí trung bình)</option>';
  STATIONS.forEach((station, idx) => {
    const option = document.createElement('option');
    option.value = idx;
    option.textContent = station.name;
    select.appendChild(option);
  });
}

// ==================== HIỂN THỊ VIEW THỜI TIẾT ====================
/*
function showWeather() {
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  document.getElementById('weatherView').style.display = 'block';
  updateNavActive('weatherView');

  // Khởi tạo dropdown từ danh sách trạm thật
  initStationSelectFromRealStations();
  // Tải dữ liệu thời tiết
  loadWeatherData();
}
*/

async function showWeather() {
  if (!requireLoginForStationDetail()) return;
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  
  if (refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  document.getElementById('weatherView').style.display = 'block';
  updateNavActive('weatherView');

  // Đợi dữ liệu trạm mới nhất từ gateway trước khi load thời tiết
  await fetchRealDataFromGateway();

  // Khởi tạo dropdown từ danh sách trạm thật
  initStationSelectFromRealStations();

  // Tải dữ liệu thời tiết (sẽ lấy giá trị mặc định từ daysSelect)
  document.getElementById('stationSelect')?.addEventListener('change', () => loadWeatherData());
document.getElementById('daysSelect')?.addEventListener('change', () => loadWeatherData());
  loadWeatherData();
}
// ==================== LẤY DỮ LIỆU TỪ API ====================
async function loadWeatherData() {
  const container = document.getElementById('dailyForecastContainer');
  if (!container) return;

  // Hiển thị loading
  container.innerHTML = `
    <div class="col-12 text-center py-5">
      <div class="spinner-border text-primary" role="status"></div>
      <p class="mt-2">Đang tải dữ liệu thời tiết...</p>
    </div>
  `;

  try {
    const stationSelect = document.getElementById('stationSelect');
    const daysSelect = document.getElementById('daysSelect');
    const selectedValue = stationSelect.value;
    const days = parseInt(daysSelect.value, 10);

    let lat, lon;

    if (selectedValue === 'all') {
      // Tính trung bình tọa độ của các trạm có vị trí hợp lệ
      const validStations = stations.filter(s => s.location && typeof s.location.lat === 'number');
      if (validStations.length === 0) throw new Error('Không có trạm nào có tọa độ');
      const sumLat = validStations.reduce((s, st) => s + st.location.lat, 0);
      const sumLon = validStations.reduce((s, st) => s + st.location.lng, 0);
      lat = sumLat / validStations.length;
      lon = sumLon / validStations.length;
    } else {
      const idx = parseInt(selectedValue, 10);
      const station = stations[idx];
      if (!station || !station.location) throw new Error('Trạm không có tọa độ');
      lat = station.location.lat;
      lon = station.location.lng;
    }

    // Gọi API OpenWeatherMap
    const url = `${BASE_URL}?lat=${lat}&lon=${lon}&units=metric&appid=${API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    displayForecast(data, days);
  } catch (error) {
    console.error('Lỗi thời tiết:', error);
    container.innerHTML = `<div class="alert alert-danger">Không thể tải dữ liệu thời tiết. Lỗi: ${error.message}</div>`;
  }
}

// ==================== HIỂN THỊ DỰ BÁO THEO NGÀY ====================
function displayForecast(data, days) {
  const container = document.getElementById('dailyForecastContainer');
  if (!container) return;

  // Nhóm các mốc 3 giờ theo ngày (lấy theo ngày địa phương)
  const dailyMap = new Map(); // key: YYYY-MM-DD, value: list of forecasts
  data.list.forEach(item => {
    const date = new Date(item.dt * 1000);
    const dateKey = date.toLocaleDateString('sv-SE'); // YYYY-MM-DD
    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, []);
    }
    dailyMap.get(dateKey).push(item);
  });

  // Chuyển thành mảng và giới hạn số ngày
  let dailyEntries = Array.from(dailyMap.entries()).slice(0, days);
  if (dailyEntries.length === 0) {
    container.innerHTML = '<div class="col-12">Không có dữ liệu dự báo.</div>';
    return;
  }

  // Xây dựng HTML cho từng ngày
  let html = '';
  for (const [dateKey, forecasts] of dailyEntries) {
    // Tính nhiệt độ cao nhất, thấp nhất trong ngày
    const temps = forecasts.map(f => f.main.temp);
    const tempMax = Math.max(...temps);
    const tempMin = Math.min(...temps);
    // Lấy icon và mô tả của thời điểm giữa trưa (khoảng 12:00) hoặc dự báo đầu tiên
    const noonForecast = forecasts.find(f => {
      const hour = new Date(f.dt * 1000).getHours();
      return hour >= 11 && hour <= 13;
    }) || forecasts[0];
    const iconCode = noonForecast.weather[0].icon;
    const description = noonForecast.weather[0].description;
    const iconUrl = `https://openweathermap.org/img/wn/${iconCode}@2x.png`;

    // Định dạng ngày hiển thị
    const displayDate = new Date(dateKey);
    const dayName = displayDate.toLocaleDateString('vi-VN', { weekday: 'long' });
    const formattedDate = displayDate.toLocaleDateString('vi-VN');

    html += `
      <div class="col-md-4 col-lg-3 mb-4">
        <div class="card h-100 shadow-sm">
          <div class="card-body text-center">
            <h5 class="card-title">${dayName}</h5>
            <p class="card-text text-muted">${formattedDate}</p>
            <img src="${iconUrl}" alt="${description}" class="mb-2" style="width: 80px;">
            <p class="mb-1">${description}</p>
            <div class="d-flex justify-content-between mt-3">
              <span><i class="fas fa-thermometer-high text-danger"></i> ${Math.round(tempMax)}°C</span>
              <span><i class="fas fa-thermometer-low text-info"></i> ${Math.round(tempMin)}°C</span>
            </div>
            <div class="mt-2">
              <i class="fas fa-tint"></i>  Độ ẩm không khí: ${noonForecast.main.humidity}%
            </div>
            <div>
              <i class="fas fa-wind"></i> Gió: ${noonForecast.wind.speed} m/s
            </div>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}


async function updateStationAddress(lat, lng) {
  const addrSpan = document.getElementById('stationAddress');
  if (!addrSpan) return;
  try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=vi`;
      const response = await fetch(url, {
          headers: { 'User-Agent': 'RRIV-Monitoring/1.0' }
      });
      const data = await response.json();
      if (data && data.display_name) {
          // Lấy tên ngắn gọn: phường/xã hoặc quận/huyện hoặc thành phố
          const addr = data.address?.suburb || data.address?.village || 
                       data.address?.town || data.address?.city || 
                       data.address?.province || data.display_name;
          addrSpan.innerText = addr;
      } else {
          addrSpan.innerText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      }
  } catch (err) {
      console.error('Lỗi lấy địa chỉ:', err);
      addrSpan.innerText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}


/*LƯU FILE CSV */

async function fetchSDCardFiles() {

  if (!canExportCSV()) {
    showToast('Bạn không có quyền xuất dữ liệu CSV', 'error');
    return;
  }
  try {
      const res = await fetch(`${GATEWAY_URL}/api/sd/files`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const files = await res.json();
      return files; // mảng các tên file, ví dụ ["2026-04-23.csv", "2026-04-24.csv"]
  } catch (err) {
      console.error("Lỗi lấy danh sách file từ SD:", err);
      showToast("Không thể đọc danh sách file từ gateway", "error");
      return [];
  }
}

async function downloadSDCardFile(fileName) {
  
  try {
      const url = `${GATEWAY_URL}/api/sd/download?file=${encodeURIComponent(fileName)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      showToast(`Đã tải file ${fileName}`, "success");
  } catch (err) {
      console.error("Lỗi tải file:", err);
      showToast(`Không thể tải file ${fileName}`, "error");
  }
}



async function showSensorLogFiles() {

  if (!canExportCSV()) {
    showToast('Bạn không có quyền xuất dữ liệu CSV', 'error');
    return;
  }

  // ===== THÊM 3 DÒNG NÀY =====
  Swal.fire({
    title: 'Đang tải danh sách file...',
    didOpen: () => Swal.showLoading(),
    allowOutsideClick: false
  });
  



  const files = await fetchSDCardFiles();
  if (!files || files.length === 0) {
      Swal.fire({
          icon: 'info',
          title: 'Không có file CSV',
          text: 'Thẻ SD chưa có file dữ liệu nào. Hãy đợi gateway ghi dữ liệu.',
          confirmButtonText: 'Đóng'
      });
      return;
  }

  // Tạo danh sách nút bấm cho từng file
  const fileButtons = files.map(file => `
      <button class="swal2-confirm swal2-styled" style="margin:5px; display:block; width:100%;" onclick="downloadSDCardFile('${file}')">
          📄 ${file}
      </button>
  `).join('');

  Swal.fire({
      title: 'Chọn file CSV cần tải',
      html: `<div style="max-height: 400px; overflow-y: auto;">${fileButtons}</div>`,
      showConfirmButton: false,
      showCloseButton: true,
      focusConfirm: false
  });
}

// Đảm bảo nút CSV gọi hàm đúng
document.addEventListener('DOMContentLoaded', () => {
  const csvBtn = document.querySelector('.ios-btn[onclick="exportChartCSV()"]') ||
                 document.querySelector('button.ios-btn i.fa-file-csv')?.parentElement;
  if (csvBtn && !csvBtn.hasAttribute('data-csv-handler')) {
      csvBtn.setAttribute('onclick', 'showSensorLogFiles()');
      csvBtn.setAttribute('data-csv-handler', 'true');
  }
});



// Hàm xóa file trên SD card (chỉ admin mới có quyền)
async function deleteSDCardFile(fileName) {
  // Kiểm tra quyền: chỉ admin hoặc người có quyền quản lý mới xóa
  if (!currentUser || currentUser.role !== 'admin') {
    showToast('Bạn không có quyền xóa file CSV', 'error');
    return;
  }

  const confirm = await Swal.fire({
    title: 'Xác nhận xóa',
    text: `Bạn có chắc chắn muốn xóa file ${fileName}?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Xóa',
    cancelButtonText: 'Hủy'
  });
  if (!confirm.isConfirmed) return;

  try {
    const response = await fetch(`${GATEWAY_URL}/api/sd/delete?file=${encodeURIComponent(fileName)}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showToast(`Đã xóa file ${fileName}`, 'success');
    // Sau khi xóa, làm mới danh sách file
    await showSensorLogFiles(); // gọi lại để cập nhật
  } catch (err) {
    console.error('Lỗi xóa file:', err);
    showToast(`Không thể xóa file ${fileName}`, 'error');
  }
}


// Kiểm tra quyền chung
function hasPermission(feature) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  if (currentUser.permissions === 'all') return true;
  if (Array.isArray(currentUser.permissions)) {
    return currentUser.permissions.includes(feature);
  }
  return false;
}

function canAccessSettings() {
  return hasPermission('config') || currentUser?.role === 'admin';
}

function canExportCSV() {
  return hasPermission('exportCSV') || currentUser?.role === 'admin';
}

function canConfigWifi() {
  return hasPermission('configWifi') || currentUser?.role === 'admin';
}

// --- Các hàm fetch và render ở trên ---

// Cuối cùng là kích hoạt vòng lặp cập nhật
setInterval(() => {
  fetchRealDataFromGateway(); // Cập nhật dữ liệu các trạm (pH, Humidity...)
  fetchNDVIFromGateway();     // Cập nhật góc nghiêng và NDVI
}, 60000); // 3000ms = 3 giây


// ========== NDVI GLOBAL VARIABLES ==========
let ndviChart = null;
let isRealtimeMode = true;
let ndviInterval = null;
let ndviDataStore = []; // Lưu trữ dữ liệu real-time
let isNDVIPageInitialized = false; // Đánh dấu đã khởi tạo chưa


// ========== CHART INITIALIZATION ==========
function initNDVIChart() {
  if (isNDVIPageInitialized) return;
    const chartDom = document.getElementById('ndviChart');
    if (!chartDom) return;
    
    if (ndviChart) ndviChart.dispose();
    ndviChart = echarts.init(chartDom);
    
    const option = {
        title: { text: 'Biến thiên NDVI (Real-time)', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(255, 255, 255, 0.9)' },
        legend: { data: ['Sensor 411', 'Sensor 412', 'Trung bình'], bottom: 0 },
        grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
        xAxis: { 
            type: 'category', 
            boundaryGap: false, 
            data: [],
            axisLabel: { rotate: 30, fontSize: 10 }
        },
        yAxis: { 
            type: 'value', 
            min: -1.0, max: 1.0,
            name: 'Giá trị NDVI',
            splitLine: { lineStyle: { type: 'dashed' } }
        },
        series: [
            {
                name: 'Sensor 411',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 4,
                lineStyle: { width: 2, color: '#dc3545' },
                data: []
            },
            {
                name: 'Sensor 412',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 4,
                lineStyle: { width: 2, color: '#0d6efd' },
                data: []
            },
            {
                name: 'Trung bình',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 4,
                lineStyle: { width: 2, color: '#198754' },
                data: []
            }
        ]
    };
    ndviChart.setOption(option);
}

// ========== UPDATE NDVI PAGE (chỉ lưu dữ liệu, không vẽ lại toàn bộ) ==========
function updateNDVIPage(data) {
    if (!data || !data.S2_411) return;

    // Tính toán NDVI
    const n411 = (data.S2_411.nir - data.S2_411.red) / (data.S2_411.nir + data.S2_411.red);
    const n412 = (data.S2_412.nir - data.S2_412.red) / (data.S2_412.nir + data.S2_412.red);
    const avg = (n411 + n412) / 2;

    // Cập nhật card hiển thị
    const elements = {
        'detail-red-411': data.S2_411.red.toFixed(4),
        'detail-nir-411': data.S2_411.nir.toFixed(4),
        'detail-ndvi-411': n411.toFixed(6),
        'detail-red-412': data.S2_412.red.toFixed(4),
        'detail-nir-412': data.S2_412.nir.toFixed(4),
        'detail-ndvi-412': n412.toFixed(4),
        'avg-ndvi': avg.toFixed(4)
    };
    
    for (const [id, value] of Object.entries(elements)) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    // FIX #4: Hiển thị badge pin Node NDVI (field mới từ /api/ndvi)
    if (data.node_battery !== undefined) {
        let badgeId = 'ndvi-node-battery-badge';
        let badge = document.getElementById(badgeId);
        if (!badge) {
            // Tạo badge một lần, gắn vào card NDVI trung bình
            const card = document.querySelector('#ndviView .card.bg-primary');
            if (card) {
                badge = document.createElement('div');
                badge.id = badgeId;
                badge.className = 'small mt-2';
                card.appendChild(badge);
            }
        }
        if (badge) {
            const bat    = data.node_battery.toFixed(0);
            const volt   = (data.node_voltage || 0).toFixed(2);
            const chg    = data.node_charge_mode;
            const chgTxt = chg === 2 ? '✅ Pin đầy' : chg === 1 ? '⚡ Đang sạc' : '🔋 Dùng pin';
            const color  = bat < 20 ? '#ff4d4d' : bat < 50 ? '#ffc107' : '#a8f0c6';
            badge.innerHTML = `<span style="color:${color}">🔋 Node NDVI: ${bat}% (${volt}V) — ${chgTxt}</span>`;
        }
    }

    // Lưu vào data store cho real-time (chỉ lưu nếu đang ở chế độ real-time)
    if (isRealtimeMode) {
        const timestamp = new Date().toLocaleTimeString();
        ndviDataStore.push({ timestamp, n411, n412, avg });
        
        // Giữ tối đa 50 điểm
        if (ndviDataStore.length > 50) ndviDataStore.shift();
        
        // Cập nhật biểu đồ nếu trang NDVI đang hiển thị
        if (ndviChart && document.getElementById('ndviView')?.style.display === 'block') {
            updateNDVIChartFromStore();
        }
    }
}

// ========== CẬP NHẬT BIỂU ĐỒ TỪ DATA STORE ==========
function updateNDVIChartFromStore() {
    if (!ndviChart || ndviDataStore.length === 0) return;
    
    const timestamps = ndviDataStore.map(d => d.timestamp);
    const ndvi411 = ndviDataStore.map(d => d.n411);
    const ndvi412 = ndviDataStore.map(d => d.n412);
    const ndviAvg = ndviDataStore.map(d => d.avg);
    
    ndviChart.setOption({
        xAxis: { data: timestamps },
        series: [
            { data: ndvi411 },
            { data: ndvi412 },
            { data: ndviAvg }
        ]
    });
}

// ========== XÓA DỮ LIỆU REAL-TIME ==========
function clearRealtimeData() {
    ndviDataStore = [];
    if (ndviChart) {
        ndviChart.setOption({
            xAxis: { data: [] },
            series: [{ data: [] }, { data: [] }, { data: [] }]
        });
    }
}

// ========== LẤY LỊCH SỬ NDVI TỪ SD ==========
async function getNDVIHistoryFromSD(range) {
    const now = new Date();
    let startDate;
    
    if (range === 'today') {
        startDate = now.toISOString().slice(0, 10);
    } else if (range === 'week') {
        const start = new Date(now);
        start.setDate(now.getDate() - 7);
        startDate = start.toISOString().slice(0, 10);
    } else {
        const start = new Date(now);
        start.setDate(now.getDate() - 30);
        startDate = start.toISOString().slice(0, 10);
    }
    
    const allFiles = await fetchSDCardFiles() || [];
    // Lọc file từ startDate đến hiện tại
    const filesInRange = allFiles.filter(fname => {
        const datePart = fname.replace('.csv', '');
        return datePart >= startDate;
    });
    
    if (filesInRange.length === 0) {
        return { timestamps: [], ndvi411: [], ndvi412: [], ndviTB: [] };
    }
    
    let records = [];
    
    for (const fname of filesInRange) {
        try {
            const csvText = await fetchCSVContent(fname);
            const rows = parseCSV(csvText);
            
            for (const row of rows) {
                const timestamp = row['Timestamp'];
                if (!timestamp) continue;
                
                // Đọc dữ liệu từ CSV (cập nhật theo format ghi trong logDataToSD)
                const red_up = parseFloat(row['RED_UP']);
                const nir_up = parseFloat(row['NIR_UP']);
                const red_down = parseFloat(row['RED_DOWN']);
                const nir_down = parseFloat(row['NIR_DOWN']);
                const ndvi_col = parseFloat(row['NDVI']);
                
                if (isNaN(red_up) || isNaN(nir_up) || isNaN(red_down) || isNaN(nir_down)) continue;
                
                // Tính NDVI
                const ndvi411 = (nir_up - red_up) / (nir_up + red_up);
                const ndvi412 = (nir_down - red_down) / (nir_down + red_down);
                const ndviTB = !isNaN(ndvi_col) ? ndvi_col : (ndvi411 + ndvi412) / 2;
                
                records.push({
                    timestamp: timestamp,
                    ndvi411: ndvi411,
                    ndvi412: ndvi412,
                    ndviTB: ndviTB
                });
            }
        } catch (err) {
            console.warn(`Lỗi đọc file ${fname}:`, err);
        }
    }
    
    // Sắp xếp theo thời gian tăng dần
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    return {
        timestamps: records.map(r => r.timestamp),
        ndvi411: records.map(r => r.ndvi411),
        ndvi412: records.map(r => r.ndvi412),
        ndviTB: records.map(r => r.ndviTB)
    };
}

// ========== HIỂN THỊ TRANG NDVI ==========
async function showNDVI() {
    if (!requireLoginForStationDetail()) return;
    
    // Dừng các timer cũ
    if (ndviInterval) {
        clearInterval(ndviInterval);
        ndviInterval = null;
    }
    
    hideAllViews();
    const ndviPage = document.getElementById('ndviView');
    if (ndviPage) ndviPage.style.display = 'block';
    else return;
    
    // Khởi tạo biểu đồ
    initNDVIChart();
    
    // Gắn sự kiện cho các nút
    const rangeSelect = document.getElementById('ndviRange');
    const refreshBtn = document.getElementById('refreshNDVI');
    const realtimeBtn = document.getElementById('realTimeNDVI');
    
    // Hàm tải lịch sử
    const loadHistory = async () => {
        const range = rangeSelect.value;
        showLoadingOverlay(true);
        
        try {
            const history = await getNDVIHistoryFromSD(range);
            showLoadingOverlay(false);
            
            if (history && history.timestamps && history.timestamps.length > 0) {
                // Chuyển sang chế độ lịch sử
                isRealtimeMode = false;
                if (ndviInterval) {
                    clearInterval(ndviInterval);
                    ndviInterval = null;
                }
                
                // Cập nhật tiêu đề
                let titleText = '';
                if (range === 'today') titleText = 'Biến thiên NDVI (Hôm nay - Lịch sử)';
                else if (range === 'week') titleText = 'Biến thiên NDVI (Tuần này - Lịch sử)';
                else titleText = 'Biến thiên NDVI (Tháng này - Lịch sử)';
                
                // Cập nhật biểu đồ với dữ liệu lịch sử
                ndviChart.setOption({
                    title: { text: titleText },
                    xAxis: { data: history.timestamps },
                    series: [
                        { data: history.ndvi411 },
                        { data: history.ndvi412 },
                        { data: history.ndviTB }
                    ]
                });
            } else {
                showToast('Không có dữ liệu NDVI trong khoảng thời gian này', 'warning');
            }
        } catch (err) {
            showLoadingOverlay(false);
            console.error('Lỗi tải lịch sử NDVI:', err);
            showToast('Lỗi tải dữ liệu lịch sử', 'error');
        }
    };
    
    // Hàm bắt đầu real-time
    const startRealtime = () => {
        isRealtimeMode = true;
        
        // Dừng interval cũ nếu có
        if (ndviInterval) {
            clearInterval(ndviInterval);
            ndviInterval = null;
        }
        
        // Không xóa data store cũ, giữ lại dữ liệu đã có
        if (ndviDataStore.length > 0) {
            updateNDVIChartFromStore();
        } else {
            // Nếu chưa có dữ liệu, xóa biểu đồ
            ndviChart.setOption({
                title: { text: 'Biến thiên NDVI (Real-time)' },
                xAxis: { data: [] },
                series: [{ data: [] }, { data: [] }, { data: [] }]
            });
        }
        
        // Lấy dữ liệu hiện tại nếu có
        if (lastNDVIData) updateNDVIPage(lastNDVIData);
        
        // Bắt đầu interval mới
        ndviInterval = setInterval(async () => {
            await fetchNDVIFromGateway();
        }, 30000); // 30 giây
    };
    
    // Gán sự kiện
    if (refreshBtn) {
        refreshBtn.onclick = () => {
            if (ndviInterval) {
                clearInterval(ndviInterval);
                ndviInterval = null;
            }
            loadHistory();
        };
    }
    
    if (realtimeBtn) {
        realtimeBtn.onclick = startRealtime;
    }
    
    // Nếu đã từng ở chế độ real-time trước đó, khôi phục
    if (isRealtimeMode && ndviDataStore.length > 0) {
        updateNDVIChartFromStore();
    }
    
    // Bắt đầu real-time mặc định
    startRealtime();
}

// ==================== CẤU HÌNH WIFI ====================
/*
function saveWifiConfiguration(ssid, password) {
  // Lấy IP hiện tại (khi ở AP mode là 192.168.4.1, khi ở STA mode là IP thật)
  let esp32Ip = window.location.hostname;

   const ssid = "a";
  const password = "b";
  
  console.log("Đang gửi WiFi config đến:", esp32Ip);
  console.log("SSID:", ssid);
  console.log("Password length:", password.length);
  
  const url = `http://${esp32Ip}/save-wifi-config`;
  
  // Hiển thị loading
  const btn = document.getElementById('saveWifiBtn');
  const originalText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu...';
    btn.disabled = true;
  }
  
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ssid: ssid,
      password: password
    })
  })
  .then(async response => {
    console.log("Response status:", response.status);
    const text = await response.text();
    console.log("Response text:", text);
    
    if (response.ok) {
      showToast('✅ Cấu hình WiFi đã được lưu! ESP32 sẽ khởi động lại...', 'success');
      setTimeout(() => {
        const modal = bootstrap.Modal.getInstance(document.getElementById('wifiConfigModal'));
        if (modal) modal.hide();
      }, 2000);
    } else {
      throw new Error(text || 'Lỗi không xác định');
    }
  })
  .catch(error => {
    console.error("Lỗi:", error);
    showToast('❌ Không thể gửi cấu hình: ' + error.message, 'error');
  })
  .finally(() => {
    if (btn) {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });
}

// Gắn sự kiện cho modal WiFi
function initWifiModal() {
  const wifiForm = document.getElementById('wifiConfigForm');
  const saveBtn = document.getElementById('saveWifiBtn');
  
  if (!wifiForm) {
    console.error("Không tìm thấy form wifiConfigForm");
    return;
  }
  
  wifiForm.addEventListener('submit', function(e) {
    e.preventDefault();
    
    const ssid = document.getElementById('newSsid').value.trim();
    const password = document.getElementById('newPassword').value;
    
    if (!ssid) {
      showToast('Vui lòng nhập tên WiFi', 'error');
      return;
    }
    
    saveWifiConfiguration(ssid, password);
  });
  
  if (saveBtn) {
    saveBtn.onclick = function() {
      wifiForm.dispatchEvent(new Event('submit'));
    };
  }
  
  console.log("WiFi modal initialized");
}

// Khởi tạo khi DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWifiModal);
} else {
  initWifiModal();
}
*/

// ========== RESET WIFI FUNCTION ==========

/**
 * Xử lý reset cấu hình WiFi
 * Gửi request đến ESP32 để xóa credentials và reboot
 */
async function resetWiFiConfig() {
  const messageDiv = document.getElementById('configMessage');
  const resetBtn = document.getElementById('resetWifiBtn');
  
  if (!resetBtn) return;
  
  // Disable button và hiển thị loading
  resetBtn.disabled = true;
  resetBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Đang xử lý...';
  
  try {
      // Gửi request đến ESP32
      const response = await fetch('/api/reset-wifi', {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json'
          }
      });
      
      const result = await response.json();
      
      if (result.status === 'success') {
          // Hiển thị thông báo thành công
          if (messageDiv) {
              messageDiv.className = 'alert alert-success mt-3';
              messageDiv.innerHTML = '<i class="fas fa-check-circle me-2"></i>✅ Đã xóa cấu hình WiFi! Getway đang khởi động lại...';
              messageDiv.classList.remove('d-none');
          }
          
          // Tự động chuyển hướng về AP mode sau 2 giây
          setTimeout(() => {
              window.location.href = 'http://192.168.4.1';
          }, 2000);
          
      } else {
          throw new Error(result.message || 'Reset failed');
      }
      
  } catch (error) {
      console.error('Reset WiFi error:', error);
      
      // Hiển thị thông báo lỗi
      if (messageDiv) {
          messageDiv.className = 'alert alert-danger mt-3';
          messageDiv.innerHTML = '<i class="fas fa-exclamation-circle me-2"></i>❌ Lỗi: ' + error.message + '. Vui lòng thử lại.';
          messageDiv.classList.remove('d-none');
      }
      
      // Reset button về trạng thái ban đầu
      resetBtn.disabled = false;
      resetBtn.innerHTML = '<i class="fas fa-trash-alt me-1"></i>Xóa & Chuyển sang chế độ AP';
      
      // Tự động ẩn thông báo sau 3 giây
      setTimeout(() => {
          if (messageDiv) {
              messageDiv.classList.add('d-none');
          }
      }, 3000);
  }
}

// ========== GẮN SỰ KIỆN KHI DOM READY ==========
document.addEventListener('DOMContentLoaded', function() {
  // Gắn sự kiện click cho nút reset (nếu tồn tại)
  const resetBtn = document.getElementById('resetWifiBtn');
  if (resetBtn) {
      resetBtn.addEventListener('click', resetWiFiConfig);
  }
  
  // Tự động đóng modal khi reset thành công (tùy chọn)
  const wifiModal = document.getElementById('wifiConfigModal');
  if (wifiModal) {
      wifiModal.addEventListener('hidden.bs.modal', function() {
          // Reset lại thông báo khi đóng modal
          const messageDiv = document.getElementById('configMessage');
          if (messageDiv) {
              messageDiv.classList.add('d-none');
              messageDiv.innerHTML = '';
          }
          
          // Reset button nếu chưa được reset (trường hợp hủy)
          const resetBtn = document.getElementById('resetWifiBtn');
          if (resetBtn && !resetBtn.disabled) {
              resetBtn.disabled = false;
              resetBtn.innerHTML = '<i class="fas fa-trash-alt me-1"></i>Xóa & Chuyển sang chế độ AP';
          }
      });
  }
});


// Lấy thông tin WiFi từ ESP32
async function fetchWifiInfo() {
  try {
      const response = await fetch('/api/wifi-info');
      if (!response.ok) throw new Error('Cannot fetch WiFi info');
      const data = await response.json();
      
      // Cập nhật badge channel
      const channelBadge = document.getElementById('wifiChannelBadge');
      if (channelBadge && data.channel !== undefined) {
          channelBadge.textContent = `CH ${data.channel}`;
          
          // Đổi màu theo chất lượng tín hiệu
          const rssi = data.rssi;
          if (rssi > -50) {
              channelBadge.style.backgroundColor = '#28a745'; // Xanh - tốt
          } else if (rssi > -70) {
              channelBadge.style.backgroundColor = '#ffc107'; // Vàng - trung bình
          } else {
              channelBadge.style.backgroundColor = '#dc3545'; // Đỏ - yếu
          }
      }
      
      // Tooltip hiển thị thông tin chi tiết
      const wifiBtn = document.getElementById('changeWifiBtn');
      if (wifiBtn && data) {
          wifiBtn.title = `📡 ${data.ssid}\n📶 RSSI: ${data.rssi} dBm\n🔊 Channel: ${data.channel}\n📍 IP: ${data.ip}`;
      }
      
      return data;
  } catch (error) {
      console.error('Lỗi lấy WiFi info:', error);
      const channelBadge = document.getElementById('wifiChannelBadge');
      if (channelBadge) {
          channelBadge.textContent = '⚠️';
          channelBadge.style.backgroundColor = '#dc3545';
      }
      return null;
  }
}

// Cập nhật định kỳ mỗi 30 giây
setInterval(() => {
  fetchWifiInfo();
}, 30000);

// Gọi ngay khi trang load
document.addEventListener('DOMContentLoaded', () => {
  fetchWifiInfo();
});
