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
  maxZoom: 36,
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
        data: [d.ph||0, d.vwc||0, d.ec||0, d.temp||0, 0, 0, 0, d.battery||0, 0, 0],
        location: {
          lat: hasGPS ? realLat : (10.8231 + (i * 0.001)),
          lng: hasGPS ? realLng : (106.6297 + (i * 0.001)),
          address: hasGPS ? `Vị trí thực tế trạm ${i}` : `Vị trí giả lập trạm ${i}`,
          isRealGPS: hasGPS
        }
      });
    }

    // Thêm node NDVI
    const ndviNode = nodesData['ndvi'];
    if (ndviNode) {
      let d = ndviNode;
      const keys = Object.keys(ndviNode);
      if (keys.length > 0 && keys[0].startsWith('-')) {
        d = ndviNode[keys.sort().pop()];
      }
      const realLat = parseFloat(d.lat) || 0;
      const realLng = parseFloat(d.lng) || 0;
      const hasGPS  = realLat !== 0 && realLng !== 0;
      newStations.push({
        id: 'NDVI_NODE',
        name: 'Node NDVI',
        isNDVI: true,
        status: true,
        data: [d.red_up||0, d.nir_up||0, d.angle_up||0, d.red_down||0, d.nir_down||0, d.angle_down||0, d.ndvi||0, d.battery||0, 0, 0],
        location: {
          lat: hasGPS ? realLat : 10.8231,
          lng: hasGPS ? realLng : 106.6297,
          address: 'Node NDVI',
          isRealGPS: hasGPS
        }
      });
    }

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
      if (updatedStation) {
        currentStation = updatedStation;
      }
    }

    updateAllDisplays(); // cập nhật bản đồ, grid, ...

    // Nếu đang ở trang chi tiết trạm -> cập nhật biểu đồ và sidebar
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
      // Cập nhật sidebar bằng dữ liệu mới nhất
      if (currentStation.data) {
        updateSidebarValues(currentStation.data);
      }
    }

    if (document.getElementById('weatherView')?.style.display === 'block') {
      initStationSelectFromRealStations();
      loadWeatherData();
    }

  } catch (error) {
    console.error('Lỗi lấy dữ liệu từ gateway:', error);
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
      ndvi: raw.ndvi || 0,
      S2_411: { red: raw.red_up||0, nir: raw.nir_up||0, angle: raw.angle_up||0 },
      S2_412: { red: raw.red_down||0, nir: raw.nir_down||0, angle: raw.angle_down||0 },
      node_battery: raw.battery||0, node_voltage: 0, node_charge_mode: 0
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
    
    // 4. Gán nội dung Popup - arrow function để tạo lại mỗi lần mở
    marker.bindPopup(() => createStationPopup(station, index), {
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
  // NDVI node: data[2]=angle_up, data[5]=angle_down — dùng angle vì red/nir có thể = 0
  const hasData = station.isNDVI
    ? station.data && (station.data[2] !== 0 || station.data[5] !== 0 || station.data[6] !== 0 || station.data[7] !== 0)
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

function createStationPopup(station, index) {
  const hasData = station.isNDVI
    ? station.data && (station.data[2] !== 0 || station.data[5] !== 0 || station.data[6] !== 0 || station.data[7] !== 0)
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

  let sensorHtml = '';
  if (!hasData) {
    sensorHtml = `
      <div class="text-center py-3">
        <i class="fas fa-satellite-dish fa-2x mb-2 d-block" style="color:#adb5bd;"></i>
        <span class="text-muted small">Chưa nhận được dữ liệu từ trạm</span>
      </div>`;
  } else if (station.isNDVI) {
    const ndvi = station.data[6];
    const ndviColor = ndvi > 0.5 ? '#28a745' : ndvi > 0.2 ? '#ffc107' : '#dc3545';
    const ndviLabel = ndvi > 0.5 ? 'Phát triển tốt' : ndvi > 0.2 ? 'Trung bình' : 'Yếu / Đất trống';
    sensorHtml = `
      <div class="text-muted small mb-1"><strong>Node NDVI — Cảm biến ánh sáng</strong></div>
      <div class="station-info mb-2">
        <div class="text-muted small mb-1"><strong>S2-411 (Hướng lên — ánh sáng tới):</strong></div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-sun text-danger"></i> Red UP:</span>
          <strong>${parseFloat(station.data[0]).toFixed(4)} W/m²</strong>
        </div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-bullseye text-secondary"></i> NIR UP:</span>
          <strong>${parseFloat(station.data[1]).toFixed(4)} W/m²</strong>
        </div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-angle-up text-info"></i> Góc UP:</span>
          <strong>${parseFloat(station.data[2]).toFixed(1)}°</strong>
        </div>
        <hr class="my-1">
        <div class="text-muted small mb-1"><strong>S2-412 (Hướng xuống — phản xạ cây):</strong></div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-sun text-warning"></i> Red DOWN:</span>
          <strong>${parseFloat(station.data[3]).toFixed(4)} W/m²</strong>
        </div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-bullseye text-primary"></i> NIR DOWN:</span>
          <strong>${parseFloat(station.data[4]).toFixed(4)} W/m²</strong>
        </div>
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-angle-down text-info"></i> Góc DOWN:</span>
          <strong>${parseFloat(station.data[5]).toFixed(1)}°</strong>
        </div>
        <hr class="my-1">
        <div class="d-flex justify-content-between small mb-1">
          <span><i class="fas fa-leaf text-success"></i> NDVI:</span>
          <strong style="color:${ndviColor};">${parseFloat(ndvi).toFixed(4)} — ${ndviLabel}</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-battery-three-quarters text-success"></i> Pin node:</span>
          <strong>${parseFloat(station.data[7]).toFixed(1)}%</strong>
        </div>
      </div>`;
  } else {
    sensorHtml = `
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
          <strong>${parseFloat(station.data[7]).toFixed(1)}%</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span><i class="fas fa-solar-panel text-info"></i> Trạng thái:</span>
          <strong>${station.data[8] === 1 ? "⚡ Đang sạc" : (station.data[8] === 2 ? "✅ Pin đầy" : "🔋 Đang dùng pin")}</strong>
        </div>
        ${alertsHtml}
      </div>`;
  }

  return `
    <div class="station-popup-content" style="min-width: 300px;">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <h6 class="mb-0"><i class="fas fa-microchip me-1"></i> ${station.name}</h6>
        ${statusText}
      </div>
      <hr class="my-1">
      ${sensorHtml}
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
  if (stations[index] && stations[index].isNDVI) {
    showNDVI();
    return;
  }
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
  historicalCache = {};
  const tu = document.getElementById('acv-update-time');
  if (tu) tu.textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
  await renderAllCharts();
  acvUpdateSummary();
}


function showAllCharts() {
  if (!requireLoginForStationDetail()) return;
  if (refreshTimer) clearInterval(refreshTimer);
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);

  hideAllViews();
  const allChartsView = document.getElementById('allChartsView');
  if (allChartsView) {
    allChartsView.style.display = 'block';
    currentTimeRange = 'week';
    historicalCache = {};
    ['day','week','month'].forEach(r => {
      const b = document.getElementById('acv-btn-' + r);
      if (b) b.classList.toggle('active', r === 'week');
    });
    const tu = document.getElementById('acv-update-time');
    if (tu) tu.textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
    renderAllCharts().then(() => {
      acvUpdateSummary();
      if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
      allChartsRefreshTimer = setInterval(refreshAllChartsWithFilter, 300000);
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
    'utilitiesView', 'weatherView', 'aboutView', 'allChartsView', 'ndviView', 'aiChatView','aiExpertView','manualDataView'
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

  // ── CSS nhúng thẳng (chỉ inject 1 lần) ──
  if (!document.getElementById('sgrid-style')) {
    const s = document.createElement('style');
    s.id = 'sgrid-style';
    s.textContent = `
      #chartView { background: #f0f2f5; padding: 10px; }
      .sg-header { background:#fff; border-radius:10px; padding:10px 14px; margin-bottom:10px;
        display:flex; align-items:center; justify-content:space-between;
        border:0.5px solid #e9ecef; flex-wrap:wrap; gap:8px; }
      .sg-pill { font-size:11px; padding:3px 10px; border-radius:20px; font-weight:500; }
      #stationGrid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
      @media(max-width:1024px){ #stationGrid { grid-template-columns:repeat(2,1fr); } }
      @media(max-width:600px) { #stationGrid { grid-template-columns:1fr; } }
      .sg-card { background:#fff; border-radius:12px; border:1px solid #e9ecef;
        overflow:hidden; transition:box-shadow .2s, border-color .2s; display:flex; flex-direction:column; }
      .sg-card:hover { box-shadow:0 4px 16px rgba(0,0,0,.09); }
      .sg-card.sg-alert { border-color:#ffc107; }
      .sg-card.sg-offline { opacity:.65; }
      .sg-card-header { padding:9px 12px 8px; display:flex; align-items:center;
        justify-content:space-between; border-bottom:1px solid #f5f5f5; }
      .sg-name { font-size:13px; font-weight:600; color:#212529;
        display:flex; align-items:center; gap:7px; }
      .sg-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .sg-dot.on  { background:#28a745; box-shadow:0 0 0 2px #d4edda; }
      .sg-dot.off { background:#adb5bd; }
      .sg-dot.alr { background:#ffc107; box-shadow:0 0 0 2px #fff3cd; }
      .sg-badge { font-size:10px; padding:2px 7px; border-radius:10px; font-weight:500; white-space:nowrap; }
      .sg-metrics { display:grid; grid-template-columns:repeat(4,1fr); }
      .sg-metric { padding:8px 4px 6px; text-align:center; }
      .sg-metric:not(:last-child) { border-right:1px solid #f5f5f5; }
      .sg-metric.warn { background:#fff8e1; }
      .sg-mlabel { font-size:9px; color:#adb5bd; text-transform:uppercase; letter-spacing:.3px; margin-bottom:3px; }
      .sg-mval { font-size:17px; font-weight:600; line-height:1; }
      .sg-munit { font-size:9px; color:#adb5bd; margin-top:1px; min-height:11px; }
      .sg-bar-track { height:3px; border-radius:2px; background:#f0f0f0; margin-top:5px; overflow:hidden; }
      .sg-bar-fill  { height:100%; border-radius:2px; transition:width .5s; }
      .sg-footer { padding:7px 12px; display:flex; align-items:center;
        justify-content:space-between; margin-top:auto; border-top:1px solid #f5f5f5; flex-wrap:wrap; gap:4px; }
      .sg-bat-wrap { display:flex; align-items:center; gap:4px; }
      .sg-bat-shell { width:26px; height:11px; border:1.5px solid #adb5bd; border-radius:2px; padding:1px; display:inline-flex; align-items:center; }
      .sg-bat-tip { width:2px; height:5px; background:#adb5bd; border-radius:0 1px 1px 0; margin-left:1px; flex-shrink:0; }
      .sg-bat-inner { height:100%; border-radius:1px; transition:width .4s; }
      .sg-gps { font-size:10px; color:#ced4da; }
      .sg-alert-tag { font-size:10px; padding:2px 7px; border-radius:8px;
        background:#fff3cd; color:#856404; display:flex; align-items:center; gap:3px; }
      .sg-no-signal { padding:18px 12px; text-align:center; flex:1; display:flex;
        flex-direction:column; align-items:center; justify-content:center; gap:6px; }
      .sg-no-signal i { font-size:26px; color:#dee2e6; }
    `;
    document.head.appendChild(s);
  }

  // ── Header tổng quan ──
  const totalOnline  = stations.filter(s => s.status && s.data && s.data.length > 0 && (s.data[0]!==0||s.data[1]!==0||s.data[3]!==0)).length;
  const totalAlert   = stations.filter(s => checkStationThresholds(s).length > 0).length;
  const totalOffline = stations.filter(s => !s.status || !s.data || s.data.length === 0).length;
  const nowStr       = new Date().toLocaleTimeString('vi-VN');

  let headerEl = document.getElementById('sg-monitor-header');
  if (!headerEl) {
    headerEl = document.createElement('div');
    headerEl.id = 'sg-monitor-header';
    headerEl.className = 'sg-header';
    grid.parentElement.insertBefore(headerEl, grid);
  }
  headerEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:13px;font-weight:600;color:#212529;">Giám sát trạm</span>
      <span class="sg-pill" style="background:#d4edda;color:#155724;">● ${totalOnline} online</span>
      ${totalAlert  ? `<span class="sg-pill" style="background:#fff3cd;color:#856404;">⚠ ${totalAlert} cảnh báo</span>` : ''}
      ${totalOffline ? `<span class="sg-pill" style="background:#f8d7da;color:#721c24;">✕ ${totalOffline} mất tín hiệu</span>` : ''}
    </div>
    <span style="font-size:11px;color:#adb5bd;">Cập nhật: ${nowStr}</span>
  `;

  // ── Helpers ──
  const clamp = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

  function batColor(pct) {
    return pct < 20 ? '#dc3545' : pct < 50 ? '#fd7e14' : '#28a745';
  }

  function metricColor(val, min, max, type) {
    const ok = val >= min && val <= max;
    if (type === 'ph')   return ok ? '#2d6a0f' : '#dc3545';
    if (type === 'vwc')  return ok ? '#0d6efd' : '#dc3545';
    if (type === 'ec')   return '#534ab7';
    if (type === 'temp') return ok ? '#dc3545' : '#fd7e14';
    return '#6c757d';
  }

  function barColor(val, min, max, type) {
    const ok = val >= min && val <= max;
    if (type === 'ph')   return ok ? '#2d6a0f' : '#dc3545';
    if (type === 'vwc')  return ok ? '#0d6efd' : '#dc3545';
    if (type === 'ec')   return '#534ab7';
    if (type === 'temp') return ok ? '#dc3545' : '#fd7e14';
    return '#adb5bd';
  }

  // ── Render từng card ──
  grid.innerHTML = '';

  stations.slice(0, 6).forEach((station) => {
    const { phMin, phMax, humMin: vwcMin, humMax: vwcMax,
            tempMin, tempMax, batteryAlert: batMin } = settings.stations;

    const hasData = station.data && station.data.length >= 8 &&
      (station.data[0] !== 0 || station.data[1] !== 0 || station.data[3] !== 0);

    const alerts = checkStationThresholds(station);
    const isAlert   = alerts.length > 0;
    const isOffline = !station.status || !hasData;

    // dot class
    const dotCls = isOffline ? 'off' : isAlert ? 'alr' : 'on';

    // badge
    let badgeHtml;
    if (isOffline) {
      badgeHtml = `<span class="sg-badge" style="background:#f8f9fa;color:#6c757d;">CHƯA CÓ TÍN HIỆU</span>`;
    } else if (isAlert) {
      badgeHtml = `<span class="sg-badge" style="background:#fff3cd;color:#856404;">⚠ CẢNH BÁO</span>`;
    } else {
      badgeHtml = `<span class="sg-badge" style="background:#d4edda;color:#155724;">ONLINE</span>`;
    }

    // ── No-signal layout ──
    if (isOffline) {
      grid.innerHTML += `
        <div class="sg-card sg-offline">
          <div class="sg-card-header">
            <div class="sg-name"><span class="sg-dot ${dotCls}"></span>${station.name}</div>
            ${badgeHtml}
          </div>
          <div class="sg-no-signal">
            <i class="fas fa-satellite-dish"></i>
            <div style="font-size:12px;color:#adb5bd;">Chưa nhận được dữ liệu</div>
            <div style="font-size:10px;color:#ced4da;">Kiểm tra kết nối thiết bị</div>
          </div>
          <div class="sg-footer">
            <div class="sg-gps"><i class="fas fa-map-marker-alt"></i> ${station.location.lat.toFixed(4)}, ${station.location.lng.toFixed(4)}</div>
            <span style="font-size:10px;color:#ced4da;">Pin: —</span>
          </div>
        </div>`;
      return;
    }

    const ph   = station.data[0];
    const vwc  = station.data[1];
    const ec   = station.data[2];
    const temp = station.data[3];
    const bat  = parseFloat(station.data[7]);
    const charging = station.data[8];

    const phWarn   = ph < phMin || ph > phMax;
    const vwcWarn  = vwc < vwcMin || vwc > vwcMax;
    const tempWarn = temp < tempMin || temp > tempMax;
    const batWarn  = bat < batMin;

    // bar widths
    const phBar   = clamp(ph, 0, 14).toFixed(0);
    const vwcBar  = vwc.toFixed(0);
    const ecBar   = clamp(ec, 0, 5).toFixed(0);
    const tempBar = clamp(temp, 10, 50).toFixed(0);

    // battery
    const batPct   = Math.min(100, Math.max(0, bat));
    const batCol   = batColor(batPct);
    const chargeStr = charging === 1 ? '⚡ Sạc' : charging === 2 ? '✅ Đầy' : '';

    // alert footer tag
    let alertTag = '';
    if (alerts.length > 0) {
      const first = alerts[0];
      const icon = first.type.includes('pH') ? '🧪'
        : first.type.includes('VWC') ? '💧'
        : first.type.includes('Nhiệt') ? '🌡️' : '⚠️';
      alertTag = `<div class="sg-alert-tag">${icon} ${first.text}</div>`;
    }
    if (batWarn && !alertTag) {
      alertTag = `<div class="sg-alert-tag">🔋 Pin yếu (${bat.toFixed(0)}%)</div>`;
    }

    grid.innerHTML += `
      <div class="sg-card${isAlert ? ' sg-alert' : ''}">
        <div class="sg-card-header">
          <div class="sg-name"><span class="sg-dot ${dotCls}"></span>${station.name}</div>
          ${badgeHtml}
        </div>

        <div class="sg-metrics">
          <div class="sg-metric${phWarn ? ' warn' : ''}">
            <div class="sg-mlabel">pH</div>
            <div class="sg-mval" style="color:${metricColor(ph, phMin, phMax, 'ph')};">${ph}</div>
            <div class="sg-munit">${phWarn ? '⚠' : '—'}</div>
            <div class="sg-bar-track"><div class="sg-bar-fill" style="width:${phBar}%;background:${barColor(ph,phMin,phMax,'ph')};"></div></div>
          </div>
          <div class="sg-metric${vwcWarn ? ' warn' : ''}">
            <div class="sg-mlabel">VWC</div>
            <div class="sg-mval" style="color:${metricColor(vwc, vwcMin, vwcMax, 'vwc')};">${vwc}</div>
            <div class="sg-munit">${vwcWarn ? '⚠ %' : '%'}</div>
            <div class="sg-bar-track"><div class="sg-bar-fill" style="width:${vwcBar}%;background:${barColor(vwc,vwcMin,vwcMax,'vwc')};"></div></div>
          </div>
          <div class="sg-metric">
            <div class="sg-mlabel">EC</div>
            <div class="sg-mval" style="color:#534ab7;">${ec}</div>
            <div class="sg-munit">dS/m</div>
            <div class="sg-bar-track"><div class="sg-bar-fill" style="width:${ecBar}%;background:#534ab7;"></div></div>
          </div>
          <div class="sg-metric${tempWarn ? ' warn' : ''}">
            <div class="sg-mlabel">Nhiệt độ</div>
            <div class="sg-mval" style="color:${metricColor(temp, tempMin, tempMax, 'temp')};">${temp}</div>
            <div class="sg-munit">${tempWarn ? '⚠ °C' : '°C'}</div>
            <div class="sg-bar-track"><div class="sg-bar-fill" style="width:${tempBar}%;background:${barColor(temp,tempMin,tempMax,'temp')};"></div></div>
          </div>
        </div>

        <div class="sg-footer">
          <div class="sg-bat-wrap">
            <div class="sg-bat-shell">
              <div class="sg-bat-inner" style="width:${batPct}%;background:${batCol};"></div>
            </div>
            <div class="sg-bat-tip"></div>
            <span style="font-size:11px;font-weight:500;color:${batCol};">${bat.toFixed(0)}%</span>
            ${chargeStr ? `<span style="font-size:10px;color:#adb5bd;margin-left:2px;">${chargeStr}</span>` : ''}
          </div>
          ${alertTag || `<div class="sg-gps"><i class="fas fa-map-marker-alt"></i> ${station.location.lat.toFixed(4)}, ${station.location.lng.toFixed(4)}</div>`}
        </div>
      </div>`;
  });

  // ── Cập nhật sensor 411/412 header bar ──
  if (stations && stations[0]) {
    const red411  = lastNDVIData ? lastNDVIData.S2_411.red.toFixed(4)   : (stations[0].data[4] || '0.0');
    const nir411  = lastNDVIData ? lastNDVIData.S2_411.nir.toFixed(4)   : (stations[0].data[5] || '0.0');
    const tilt411 = lastNDVIData ? lastNDVIData.S2_411.angle.toFixed(1) : '0.0';
    const red412  = lastNDVIData ? lastNDVIData.S2_412.red.toFixed(4)   : '0.0';
    const nir412  = lastNDVIData ? lastNDVIData.S2_412.nir.toFixed(4)   : '0.0';
    const tilt412 = lastNDVIData ? lastNDVIData.S2_412.angle.toFixed(1) : '0.0';

    const s = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    s('411-red', red411); s('411-nir', nir411); s('411-tilt', tilt411);
    s('412-red', red412); s('412-nir', nir412); s('412-tilt', tilt412);
  }

  if (typeof updateSunPathUI === 'function') updateSunPathUI();
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

// ================================================================
// HƯỚNG DẪN COPY-PASTE VÀO script.js
//
// Tìm dòng:    function initStationSelectFromRealStations() {
// Xóa từ đó đến hết function displayForecast() { ... }
// (tức là xóa đến ngay trước dòng: async function updateStationAddress)
// Dán toàn bộ nội dung file này vào thay thế
// ================================================================

// ── CSS inject 1 lần ──
(function injectWeatherCSS() {
  if (document.getElementById('weather-style')) return;
  const s = document.createElement('style');
  s.id = 'weather-style';
  s.textContent = `
    #weatherView { background:#f0f2f5; padding:10px; display:flex; flex-direction:column; gap:10px; }
    .wh-header { background:#fff; border-radius:12px; padding:12px 16px; border:0.5px solid #e9ecef;
      display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
    .wh-loc-name { font-size:14px; font-weight:600; color:#212529; }
    .wh-loc-sub  { font-size:11px; color:#adb5bd; }
    .wh-select   { font-size:12px; padding:4px 10px; border-radius:8px;
      border:0.5px solid #dee2e6; background:#f8f9fa; color:#495057; cursor:pointer; }
    .wh-today { background:linear-gradient(135deg,#1565c0 0%,#0288d1 100%);
      border-radius:12px; padding:16px; color:#fff;
      display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media(max-width:600px){ .wh-today { grid-template-columns:1fr; } }
    .wh-today-temp { font-size:52px; font-weight:300; line-height:1; margin:4px 0; }
    .wh-today-desc { font-size:13px; opacity:.9; margin-bottom:8px; }
    .wh-today-mm   { font-size:12px; opacity:.75; }
    .wh-stat { display:flex; align-items:center; gap:8px;
      background:rgba(255,255,255,.15); border-radius:8px; padding:7px 10px; }
    .wh-stat-label { font-size:9px; opacity:.7; text-transform:uppercase; }
    .wh-stat-val   { font-size:13px; font-weight:600; }
    .wh-agri { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
    @media(max-width:700px){ .wh-agri { grid-template-columns:repeat(2,1fr); } }
    @media(max-width:400px){ .wh-agri { grid-template-columns:1fr; } }
    .wh-agri-card { border-radius:10px; padding:10px 12px;
      display:flex; align-items:flex-start; gap:8px; }
    .wh-agri-icon  { font-size:20px; flex-shrink:0; }
    .wh-agri-label { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; margin-bottom:2px; }
    .wh-agri-val   { font-size:13px; font-weight:600; }
    .wh-agri-sub   { font-size:10px; margin-top:2px; }
    .wh-days { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; }
    @media(max-width:700px){ .wh-days { grid-template-columns:repeat(4,1fr); } }
    @media(max-width:400px){ .wh-days { grid-template-columns:repeat(2,1fr); } }
    .wh-day-card { background:#fff; border-radius:10px; padding:8px 6px; text-align:center;
      border:0.5px solid #e9ecef; cursor:pointer; transition:all .15s; }
    .wh-day-card:hover, .wh-day-card.active { border-color:#0288d1; background:#e3f2fd; }
    .wh-day-name { font-size:10px; color:#6c757d; font-weight:500; }
    .wh-day-date { font-size:9px;  color:#adb5bd; margin-bottom:4px; }
    .wh-day-icon { font-size:22px; margin:3px 0; }
    .wh-day-max  { font-size:13px; font-weight:600; color:#dc3545; }
    .wh-day-min  { font-size:11px; color:#0d6efd; }
    .wh-day-rain { font-size:9px;  color:#0288d1; margin-top:2px; }
    .wh-panel { background:#fff; border-radius:12px; padding:14px; border:0.5px solid #e9ecef; }
    .wh-panel-title { font-size:12px; font-weight:600; color:#495057;
      margin-bottom:12px; display:flex; align-items:center; gap:6px; }
    .wh-hourly { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; }
    .wh-hour-card { background:#f8f9fa; border-radius:8px; padding:8px 10px;
      text-align:center; min-width:58px; flex-shrink:0; }
    .wh-hour-time { font-size:10px; color:#6c757d; }
    .wh-hour-icon { font-size:18px; margin:3px 0; }
    .wh-hour-temp { font-size:13px; font-weight:600; color:#212529; }
    .wh-hour-rain { font-size:9px;  color:#0288d1; margin-top:2px; }
    .wh-advice { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media(max-width:600px){ .wh-advice { grid-template-columns:1fr; } }
    .wh-adv-item { border-radius:10px; padding:11px 13px;
      display:flex; align-items:flex-start; gap:10px; }
    .wh-adv-icon  { font-size:22px; flex-shrink:0; }
    .wh-adv-title { font-size:12px; font-weight:600; margin-bottom:3px; }
    .wh-adv-body  { font-size:11px; line-height:1.55; color:#495057; }
  `;
  document.head.appendChild(s);
})();

// ── Helpers ──
function wIconEmoji(code) {
  if (!code) return '🌡️';
  const id = code.replace('n','d');
  const map = {
    '01d':'☀️','02d':'🌤️','03d':'⛅','04d':'☁️',
    '09d':'🌧️','10d':'🌦️','11d':'⛈️','13d':'❄️','50d':'🌫️'
  };
  return map[id] || '🌡️';
}

function wRainColor(pop) {
  // pop: 0–1
  if (pop >= 0.6) return '#dc3545';
  if (pop >= 0.3) return '#fd7e14';
  return '#0288d1';
}

function wWindDir(deg) {
  const dirs = ['B','ĐB','Đ','ĐN','N','TN','T','TB'];
  return dirs[Math.round(deg / 45) % 8] || '—';
}

// ── Agri advice logic ──
function wAgriAdvice(dayEntries) {
  // dayEntries: mảng 7 ngày [{date,tempMax,tempMin,humidity,windSpeed,pop,rain}]
  if (!dayEntries || dayEntries.length === 0) return [];

  const today = dayEntries[0];
  const next3Rain  = dayEntries.slice(1, 4).some(d => d.pop >= 0.6);
  const todayRain  = today.pop >= 0.4;
  const hotMidday  = today.tempMax >= 33;
  const goodWind   = today.windSpeed <= 3;
  const rainDays   = dayEntries.filter(d => d.pop >= 0.6);
  const dryDays    = dayEntries.filter(d => d.pop < 0.2);

  // Tưới nước
  let water, waterSub, waterColor, waterBg;
  if (todayRain || next3Rain) {
    water = 'Không cần tưới hôm nay'; waterSub = `Mưa ${Math.round(today.pop*100)}% — đất đủ ẩm`;
    waterColor = '#2d6a0f'; waterBg = '#e8f5e0';
  } else if (today.humidity < 50) {
    water = 'Cần tưới — đất khô'; waterSub = 'Độ ẩm KK thấp, tưới sáng sớm hoặc chiều mát';
    waterColor = '#dc3545'; waterBg = '#fde8e8';
  } else {
    water = 'Tưới nhẹ nếu cần'; waterSub = 'Theo dõi VWC sensor để quyết định';
    waterColor = '#e65100'; waterBg = '#fff3e0';
  }

  // Bón phân
  let fert, fertSub, fertColor, fertBg;
  if (next3Rain) {
    const rainDay = dayEntries.slice(1,4).find(d => d.pop >= 0.6);
    fert = 'Bón ngay hôm nay hoặc mai';
    fertSub = `Tránh bón trước ${rainDay ? rainDay.dayName : 'ngày mưa'} — dễ bị rửa trôi`;
    fertColor = '#e65100'; fertBg = '#fff3e0';
  } else if (todayRain) {
    fert = 'Hoãn bón phân'; fertSub = 'Có mưa hôm nay — chờ đất ráo';
    fertColor = '#dc3545'; fertBg = '#fde8e8';
  } else {
    fert = 'Thích hợp bón phân'; fertSub = 'Thời tiết ổn định, bón sáng sớm';
    fertColor = '#2d6a0f'; fertBg = '#e8f5e0';
  }

  // Phun thuốc
  let spray, spraySub, sprayColor, sprayBg;
  if (!goodWind) {
    spray = 'Không phun — gió mạnh'; spraySub = `Gió ${today.windSpeed.toFixed(1)} m/s — thuốc bay xa`;
    sprayColor = '#dc3545'; sprayBg = '#fde8e8';
  } else if (todayRain) {
    spray = 'Không phun — có mưa'; spraySub = 'Mưa làm loãng thuốc, mất hiệu quả';
    sprayColor = '#dc3545'; sprayBg = '#fde8e8';
  } else {
    spray = 'Phun sáng sớm (6–9h)'; spraySub = `Gió ${today.windSpeed.toFixed(1)} m/s ✓ — trước khi nắng gắt`;
    sprayColor = '#2d6a0f'; sprayBg = '#e8f5e0';
  }

  // Cảnh báo
  let warn, warnSub, warnColor, warnBg;
  if (hotMidday && rainDays.length >= 2) {
    warn = 'Nắng nóng + mưa lớn cuối tuần'; warnSub = `Nhiệt ${today.tempMax}°C 12–15h. ${rainDays.length} ngày mưa to — kiểm tra thoát nước`;
    warnColor = '#b71c1c'; warnBg = '#fde8e8';
  } else if (hotMidday) {
    warn = `Nắng nóng 12–15h (${today.tempMax}°C)`; warnSub = 'UV cao — che phủ cây con, tưới gốc';
    warnColor = '#e65100'; warnBg = '#fff3e0';
  } else if (rainDays.length >= 3) {
    warn = `Mưa kéo dài ${rainDays.length} ngày tới`; warnSub = 'Nguy cơ úng ngập — kiểm tra rãnh thoát nước';
    warnColor = '#0d47a1'; warnBg = '#e3f2fd';
  } else {
    warn = 'Không có cảnh báo đặc biệt'; warnSub = 'Thời tiết thuận lợi cho canh tác';
    warnColor = '#2d6a0f'; warnBg = '#e8f5e0';
  }

  // Khuyến nghị 7 ngày (advice panel)
  let advWater, advFert, advSpray, advAlert;

  // Water advice
  const noWaterDays = rainDays.map(d => d.dayName).join(', ');
  const dryDayNames = dryDays.map(d => d.dayName).join(', ');
  advWater = rainDays.length > 0
    ? `Ngưng tưới vào: ${noWaterDays}. ${dryDays.length > 0 ? 'Tưới bổ sung: ' + dryDayNames : ''}`
    : 'Tưới đều theo VWC sensor — không có mưa lớn trong tuần.';

  // Fert advice
  const firstRainDay = dayEntries.findIndex(d => d.pop >= 0.6);
  advFert = firstRainDay === 1
    ? 'Bón ngay hôm nay (sáng sớm) vì ngày mai bắt đầu có mưa.'
    : firstRainDay > 1
    ? `Bón trước ngày ${dayEntries[firstRainDay]?.dayName || ''} để tránh rửa trôi.`
    : 'Thời tiết ổn định cả tuần — bón theo lịch canh tác bình thường.';

  // Spray advice
  const goodSprayDays = dayEntries.filter(d => d.pop < 0.2 && d.windSpeed <= 3).map(d => d.dayName);
  advSpray = goodSprayDays.length > 0
    ? `Khung tốt để phun: ${goodSprayDays.join(', ')} — sáng sớm trước 9h.`
    : 'Tuần này nhiều mưa và gió — hạn chế phun thuốc, chờ thời tiết ổn.';

  // Alert advice
  const hotDays = dayEntries.filter(d => d.tempMax >= 33).map(d => d.dayName);
  advAlert = hotDays.length > 0 && rainDays.length >= 2
    ? `Nắng nóng ${hotDays.join(', ')} + mưa lớn ${rainDays.length} ngày — kiểm tra hệ thống thoát nước TRƯỚC ${rainDays[0]?.dayName}.`
    : hotDays.length > 0
    ? `Nắng nóng ${hotDays.join(', ')} — che phủ cây con, tưới gốc buổi sáng.`
    : rainDays.length >= 3
    ? `Mưa kéo dài ${rainDays.length} ngày — theo dõi độ ẩm đất tránh ngập úng.`
    : 'Thời tiết thuận lợi — không có cảnh báo đặc biệt trong tuần.';

  return {
    water: { icon:'💧', label:'Tưới nước', val:water, sub:waterSub, color:waterColor, bg:waterBg },
    fert:  { icon:'🌿', label:'Bón phân',  val:fert,  sub:fertSub,  color:fertColor,  bg:fertBg  },
    spray: { icon:'🚿', label:'Phun thuốc',val:spray, sub:spraySub, color:sprayColor, bg:sprayBg },
    warn:  { icon:'⚠️', label:'Cảnh báo', val:warn,  sub:warnSub,  color:warnColor,  bg:warnBg  },
    advWater, advFert, advSpray, advAlert
  };
}

// ── Render toàn bộ trang thời tiết ──
function renderWeatherPage(rawData, lat, lon, locationName) {
  const view = document.getElementById('weatherView');
  if (!view) return;

  // Parse dữ liệu
  const dailyMap = new Map();
  rawData.list.forEach(item => {
    const d = new Date(item.dt * 1000);
    const key = d.toLocaleDateString('sv-SE');
    if (!dailyMap.has(key)) dailyMap.set(key, []);
    dailyMap.get(key).push(item);
  });

  const dayEntries = Array.from(dailyMap.entries()).slice(0, 7).map(([dateKey, items]) => {
    const temps   = items.map(i => i.main.temp);
    const noon    = items.find(i => { const h = new Date(i.dt*1000).getHours(); return h >= 11 && h <= 13; }) || items[0];
    const maxPop  = Math.max(...items.map(i => i.pop || 0));
    const totalRain = items.reduce((s, i) => s + (i.rain?.['3h'] || 0), 0);
    const avgHum  = items.reduce((s, i) => s + i.main.humidity, 0) / items.length;
    const avgWind = items.reduce((s, i) => s + i.wind.speed, 0) / items.length;
    const date    = new Date(dateKey);
    const dayName = date.toLocaleDateString('vi-VN', { weekday:'short' });
    const dayDate = date.toLocaleDateString('vi-VN', { day:'numeric', month:'numeric' });
    return {
      dateKey, items, noon, dayName, dayDate,
      tempMax: Math.max(...temps),
      tempMin: Math.min(...temps),
      humidity: Math.round(avgHum),
      windSpeed: +avgWind.toFixed(1),
      windDeg: noon.wind.deg || 0,
      pop: maxPop,
      rain: +totalRain.toFixed(1),
      icon: noon.weather[0].icon,
      desc: noon.weather[0].description,
    };
  });

  if (dayEntries.length === 0) return;

  const today   = dayEntries[0];
  const advice  = wAgriAdvice(dayEntries);
  let selectedDay = 0;

  // ── Build HTML ──
  function buildDayStrip() {
    return dayEntries.map((d, i) => `
      <div class="wh-day-card${i === selectedDay ? ' active' : ''}" onclick="wSelectDay(${i})">
        <div class="wh-day-name">${i === 0 ? 'Hôm nay' : d.dayName}</div>
        <div class="wh-day-date">${d.dayDate}</div>
        <div class="wh-day-icon">${wIconEmoji(d.icon)}</div>
        <div class="wh-day-max">${Math.round(d.tempMax)}°</div>
        <div class="wh-day-min">${Math.round(d.tempMin)}°</div>
        <div class="wh-day-rain" style="color:${wRainColor(d.pop)};">
          🌧 ${Math.round(d.pop * 100)}%
        </div>
      </div>`).join('');
  }

  function buildHourly(dayIdx) {
    const items = dayEntries[dayIdx]?.items || [];
    if (items.length === 0) return '<div style="color:#adb5bd;font-size:12px;padding:10px;">Không có dữ liệu giờ</div>';
    return items.map(item => {
      const h    = new Date(item.dt * 1000).toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' });
      const pop  = item.pop || 0;
      const temp = Math.round(item.main.temp);
      const isHot = temp >= 33;
      return `
        <div class="wh-hour-card" style="${isHot ? 'background:#fff3e0;' : ''}">
          <div class="wh-hour-time">${h}</div>
          <div class="wh-hour-icon">${wIconEmoji(item.weather[0].icon)}</div>
          <div class="wh-hour-temp" style="color:${isHot ? '#dc3545' : '#212529'};">${temp}°</div>
          <div class="wh-hour-rain" style="color:${wRainColor(pop)};">🌧 ${Math.round(pop*100)}%</div>
        </div>`;
    }).join('');
  }
  view.removeAttribute('data-loading');   // ← thêm dòng này
  view.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;padding:10px;">

      <!-- Header -->
      <div class="wh-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">📍</span>
          <div>
            <div class="wh-loc-name" id="wh-loc-name">${locationName || (lat.toFixed(3)+'°N · '+lon.toFixed(3)+'°E')}</div>
            <div class="wh-loc-sub">${lat.toFixed(4)}°N · ${lon.toFixed(4)}°E</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="stationSelect" class="wh-select" onchange="loadWeatherData()">
            <option value="all">Tất cả trạm</option>
          </select>
          <span style="font-size:11px;color:#adb5bd;">Cập nhật: ${new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</span>
        </div>
      </div>

      <!-- Today big card -->
      <div class="wh-today">
        <div>
          <div style="font-size:11px;opacity:.8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">
            Hôm nay · ${new Date().toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'numeric'})}
          </div>
          <div class="wh-today-temp">${Math.round(today.tempMax)}°</div>
          <div class="wh-today-desc">${wIconEmoji(today.icon)} ${today.desc}</div>
          <div class="wh-today-mm">Thấp: ${Math.round(today.tempMin)}° · Cao: ${Math.round(today.tempMax)}°</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:7px;justify-content:center;">
          <div class="wh-stat">
            <span>💧</span>
            <div><div class="wh-stat-label">Độ ẩm KK</div><div class="wh-stat-val">${today.humidity}%</div></div>
          </div>
          <div class="wh-stat">
            <span>💨</span>
            <div><div class="wh-stat-label">Gió</div><div class="wh-stat-val">${today.windSpeed} m/s · ${wWindDir(today.windDeg)}</div></div>
          </div>
          <div class="wh-stat">
            <span>🌧️</span>
            <div><div class="wh-stat-label">Xác suất mưa</div><div class="wh-stat-val">${Math.round(today.pop*100)}%${today.rain > 0 ? ' · '+today.rain+'mm' : ''}</div></div>
          </div>
          <div class="wh-stat">
            <span>🌱</span>
            <div><div class="wh-stat-label">Lượng mưa</div><div class="wh-stat-val">${today.rain > 0 ? today.rain+' mm' : 'Không mưa'}</div></div>
          </div>
        </div>
      </div>

      <!-- 4 agri quick indicators -->
      <div class="wh-agri">
        ${['water','fert','spray','warn'].map(k => {
          const a = advice[k];
          return `<div class="wh-agri-card" style="background:${a.bg};">
            <span class="wh-agri-icon">${a.icon}</span>
            <div>
              <div class="wh-agri-label" style="color:${a.color};">${a.label}</div>
              <div class="wh-agri-val" style="color:${a.color};">${a.val}</div>
              <div class="wh-agri-sub" style="color:${a.color}cc;">${a.sub}</div>
            </div>
          </div>`;
        }).join('')}
      </div>

      <!-- 7-day strip -->
      <div class="wh-days" id="wh-day-strip">${buildDayStrip()}</div>

      <!-- Hourly detail -->
      <div class="wh-panel">
        <div class="wh-panel-title" id="wh-hourly-title">🕐 Dự báo theo giờ — Hôm nay</div>
        <div class="wh-hourly" id="wh-hourly-wrap">${buildHourly(0)}</div>
      </div>

      <!-- Agri advice 7-day -->
      <div class="wh-panel">
        <div class="wh-panel-title">🌾 Khuyến nghị canh tác — 7 ngày tới</div>
        <div class="wh-advice">
          <div class="wh-adv-item" style="background:#e8f5e0;">
            <span class="wh-adv-icon">💧</span>
            <div>
              <div class="wh-adv-title" style="color:#2d6a0f;">Tưới nước</div>
              <div class="wh-adv-body">${advice.advWater}</div>
            </div>
          </div>
          <div class="wh-adv-item" style="background:#e3f2fd;">
            <span class="wh-adv-icon">🌿</span>
            <div>
              <div class="wh-adv-title" style="color:#0d47a1;">Bón phân</div>
              <div class="wh-adv-body">${advice.advFert}</div>
            </div>
          </div>
          <div class="wh-adv-item" style="background:#f3e5f5;">
            <span class="wh-adv-icon">🚿</span>
            <div>
              <div class="wh-adv-title" style="color:#4a148c;">Phun thuốc</div>
              <div class="wh-adv-body">${advice.advSpray}</div>
            </div>
          </div>
          <div class="wh-adv-item" style="background:#fff8e1;">
            <span class="wh-adv-icon">⚠️</span>
            <div>
              <div class="wh-adv-title" style="color:#e65100;">Cảnh báo</div>
              <div class="wh-adv-body">${advice.advAlert}</div>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;

  // Gắn lại select trạm
  initStationSelectFromRealStations();

  // Hàm chọn ngày (gắn vào window để onclick gọi được)
  window.wSelectDay = function(idx) {
    selectedDay = idx;
    // cập nhật strip
    document.querySelectorAll('.wh-day-card').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    // cập nhật hourly
    const d = dayEntries[idx];
    const titleEl = document.getElementById('wh-hourly-title');
    const wrapEl  = document.getElementById('wh-hourly-wrap');
    if (titleEl) titleEl.textContent = `🕐 Dự báo theo giờ — ${idx === 0 ? 'Hôm nay' : d.dayName + ' ' + d.dayDate}`;
    if (wrapEl)  wrapEl.innerHTML = buildHourly(idx);
  };

  // Lấy tên địa chỉ thật
  updateStationAddress(lat, lon);
}

// ── initStationSelectFromRealStations ──
function initStationSelectFromRealStations() {
  const select = document.getElementById('stationSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="all">Tất cả trạm (vị trí trung bình)</option>';
  stations.forEach((station, idx) => {
    if (station.location && typeof station.location.lat === 'number') {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = station.name;
      select.appendChild(opt);
    }
  });
  if (current) select.value = current;
  select.onchange = () => loadWeatherData();
}

// ── initStationSelect (fallback) ──
function initStationSelect() {
  initStationSelectFromRealStations();
}

// ── showWeather ──
async function showWeather() {
  if (!requireLoginForStationDetail()) return;
  if (typeof allChartsRefreshTimer !== 'undefined' && allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (typeof refreshTimer !== 'undefined' && refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  const view = document.getElementById('weatherView');
  if (view) view.setAttribute('data-loading', '');   // ← thêm dòng này
  if (view) view.style.display = 'block';
  updateNavActive('weatherView');


  // Spinner trong khi chờ
const _fc = document.getElementById('dailyForecastContainer');
if (_fc) _fc.innerHTML = `
  <div class="col-12 d-flex flex-column align-items-center justify-content-center py-5" style="min-height:220px;">
    <div class="spinner-border text-success mb-3" style="width:3rem;height:3rem;" role="status"></div>
    <div class="fw-bold text-muted">Đang tải dữ liệu thời tiết...</div>
    <div class="small text-muted mt-1">Vui lòng chờ trong giây lát</div>
  </div>`;


  await fetchRealDataFromGateway();
  await loadWeatherData();
}

// ── loadWeatherData ──
async function loadWeatherData() {
  const view = document.getElementById('weatherView');
  if (!view) return;

  view.innerHTML = `
    <div style="text-align:center;padding:60px 20px;color:#6c757d;">
      <i class="fas fa-spinner fa-spin fa-2x"></i>
      <div style="margin-top:12px;font-size:13px;">Đang tải dữ liệu thời tiết...</div>
    </div>`;

  try {
    const select = document.getElementById('stationSelect') || { value: 'all' };
    const selectedValue = select.value || 'all';

    let lat, lon;
    if (selectedValue === 'all') {
      const valid = stations.filter(s => s.location && typeof s.location.lat === 'number');
      if (valid.length === 0) throw new Error('Không có trạm nào có tọa độ');
      lat = valid.reduce((s, st) => s + st.location.lat, 0) / valid.length;
      lon = valid.reduce((s, st) => s + st.location.lng, 0) / valid.length;
    } else {
      const idx = parseInt(selectedValue, 10);
      const st  = stations[idx];
      if (!st || !st.location) throw new Error('Trạm không có tọa độ');
      lat = st.location.lat;
      lon = st.location.lng;
    }

    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${API_KEY}&lang=vi&cnt=56`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`OpenWeatherMap HTTP ${res.status}`);
    const data = await res.json();

    renderWeatherPage(data, lat, lon, null);

  } catch (err) {
    console.error('loadWeatherData error:', err);
    if (view) view.innerHTML = `
      <div style="padding:20px;">
        <div style="background:#fde8e8;border-radius:10px;padding:16px;color:#b71c1c;font-size:13px;">
          ⚠️ Không thể tải dữ liệu thời tiết: ${err.message}
        </div>
      </div>`;
  }
}

// displayForecast giữ lại để không lỗi nếu nơi khác gọi
function displayForecast(data, days) {
  renderWeatherPage(data, 0, 0, null);
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
let ndviDataStore = [];
let ndviCurrentMode = 'realtime';

// ========== NDVI HELPERS ==========
function ndviGetHealthInfo(val) {
  if (val === null || isNaN(val)) return { label: 'Đang phân tích...', color: '#6c757d', bg: '#f8f9fa' };
  if (val < 0.2) return { label: 'Đất trống / Cây chết', color: '#dc3545', bg: '#fde8e8' };
  if (val < 0.4) return { label: 'Cây yếu, căng thẳng', color: '#fd7e14', bg: '#fff3e0' };
  if (val < 0.6) return { label: 'Phát triển trung bình', color: '#5a8c1a', bg: '#f0f7e0' };
  return { label: 'Phát triển tốt ✓', color: '#2d6a0f', bg: '#e8f5e0' };
}

function ndviGetRecommendations(ndvi, ratio) {
  const water = ndvi < 0.3
    ? { text: 'Tưới nước: Cần tưới ngay', sub: 'NDVI thấp — cây đang thiếu nước nghiêm trọng', icon: '💧', bg: '#fde8e8' }
    : ndvi < 0.5
    ? { text: 'Tưới nước: Tăng tần suất', sub: 'NDVI trung bình — kiểm tra độ ẩm đất', icon: '💧', bg: '#fff3e0' }
    : { text: 'Tưới nước: Duy trì hiện tại', sub: 'NDVI tốt — cây hấp thụ nước ổn định', icon: '💧', bg: '#e8f5e0' };

  const fert = ratio < 1.5
    ? { text: 'Bón phân: Cần bổ sung Nitrogen', sub: 'NIR/RED thấp — lá cây thiếu diệp lục', icon: '🌿', bg: '#fde8e8' }
    : ratio < 2.2
    ? { text: 'Bón phân: Bổ sung nhẹ Nitrogen', sub: `NIR/RED = ${ratio.toFixed(2)} — có thể cải thiện thêm`, icon: '🌿', bg: '#fff3e0' }
    : { text: 'Bón phân: Mức hiện tại phù hợp', sub: `NIR/RED = ${ratio.toFixed(2)} — diệp lục tốt`, icon: '🌿', bg: '#e8f5e0' };

  return { water, fert };
}

function ndviUpdateRecommendations(ndvi411, nir411, red411, ndvi412, nir412, red412) {
  const avgNdvi = (ndvi411 + ndvi412) / 2;
  const avgRatio = ((nir411 / (red411 || 0.001)) + (nir412 / (red412 || 0.001))) / 2;
  const diff = Math.abs(ndvi411 - ndvi412);

  const { water, fert } = ndviGetRecommendations(avgNdvi, avgRatio);

  const wEl = document.getElementById('rec-water');
  const wSub = document.getElementById('rec-water-sub');
  const fEl = document.getElementById('rec-fert');
  const fSub = document.getElementById('rec-fert-sub');
  const aEl = document.getElementById('rec-alert');
  const aSub = document.getElementById('rec-alert-sub');

  if (wEl) { wEl.textContent = water.text; wEl.parentElement.previousElementSibling.style.background = water.bg; }
  if (wSub) wSub.textContent = water.sub;
  if (fEl) { fEl.textContent = fert.text; fEl.parentElement.previousElementSibling.style.background = fert.bg; }
  if (fSub) fSub.textContent = fert.sub;
  if (aEl) aEl.textContent = `Chênh lệch sensor: ${diff.toFixed(4)}`;
  if (aSub) aSub.textContent = diff < 0.02 ? 'Hai sensor đồng nhất — không có vùng bất thường' : diff < 0.05 ? 'Chênh lệch nhỏ — kiểm tra góc đo' : '⚠️ Chênh lệch lớn — kiểm tra lắp đặt sensor';
}

function ndviUpdateSpectrum(r411, n411, r412, n412) {
  const maxVal = Math.max(r411, n411, r412, n412, 0.001);
  const pct = v => Math.min(99, Math.round((v / maxVal) * 95));

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val.toFixed(4) + ' W·m⁻²·nm⁻¹'; };
  const bar = (id, pctVal) => { const el = document.getElementById(id); if (el) el.style.width = pctVal + '%'; };

  set('spec-red411', r411); bar('bar-red411', pct(r411));
  set('spec-red412', r412); bar('bar-red412', pct(r412));
  set('spec-nir411', n411); bar('bar-nir411', pct(n411));
  set('spec-nir412', n412); bar('bar-nir412', pct(n412));

  const ratio = ((n411 / (r411 || 0.001)) + (n412 / (r412 || 0.001))) / 2;
  const noteEl = document.getElementById('ndvi-ratio-note');
  if (noteEl) {
    const healthNote = ratio > 2 ? 'Cây hấp thụ mạnh ánh sáng đỏ, phản chiếu cao hồng ngoại → sức khỏe tốt'
      : ratio > 1.5 ? 'Tỉ lệ NIR/RED trung bình — cây đang phát triển'
      : 'NIR/RED thấp — cây có thể thiếu diệp lục';
    noteEl.textContent = `NIR/RED ratio: ${ratio.toFixed(2)} · ${healthNote}`;
  }
}

function ndviUpdateGauge(val) {
  // val từ -1 đến 1, map thành 0-100%
  const pct = Math.max(0, Math.min(100, ((val + 1) / 2) * 100));
  const needle1 = document.getElementById('ndvi-gauge-needle');
  const needle2 = document.getElementById('ndvi-scale-needle');
  if (needle1) needle1.style.left = pct + '%';
  if (needle2) needle2.style.left = pct + '%';
}

// ========== UPDATE NDVI PAGE ==========
function updateNDVIPage(data) {
  if (!data || !data.S2_411) return;

  const r411 = data.S2_411.red, n411 = data.S2_411.nir;
  const r412 = data.S2_412.red, n412 = data.S2_412.nir;
  const nd411 = (n411 - r411) / (n411 + r411 || 0.001);
  const nd412 = (n412 - r412) / (n412 + r412 || 0.001);
  const avg = (nd411 + nd412) / 2;

  // Cards
  const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  setEl('detail-red-411', r411.toFixed(4)); setEl('detail-nir-411', n411.toFixed(4)); setEl('detail-ndvi-411', nd411.toFixed(4));
  setEl('detail-red-412', r412.toFixed(4)); setEl('detail-nir-412', n412.toFixed(4)); setEl('detail-ndvi-412', nd412.toFixed(4));
  setEl('ndvi-tilt-411', `Góc đo: ${(data.S2_411.angle || 0).toFixed(1)}°`);
  setEl('ndvi-tilt-412', `Góc đo: ${(data.S2_412.angle || 0).toFixed(1)}°`);
  setEl('avg-ndvi', avg.toFixed(4));

  // Gauge + badge
  ndviUpdateGauge(avg);
  const health = ndviGetHealthInfo(avg);
  const badge = document.getElementById('ndvi-health-badge');
  if (badge) { badge.textContent = health.label; badge.style.color = health.color; badge.style.background = health.bg; }

  // Timestamp
  const now = new Date();
  setEl('ndvi-update-time', now.toLocaleTimeString('vi-VN'));
  setEl('ndvi-update-date', now.toLocaleDateString('vi-VN'));

  // Spectrum
  ndviUpdateSpectrum(r411, n411, r412, n412);

  // Recommendations
  ndviUpdateRecommendations(nd411, n411, r411, nd412, n412, r412);

  // Realtime store
  if (isRealtimeMode) {
    const ts = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    ndviDataStore.push({ timestamp: ts, n411: nd411, n412: nd412, avg });
    if (ndviDataStore.length > 60) ndviDataStore.shift();
    if (ndviChart && document.getElementById('ndviView')?.style.display !== 'none') {
      ndviUpdateChartRealtime();
    }
  }

  // Badge pin node NDVI (nếu có)
  if (data.node_battery !== undefined) {
    let badgeId = 'ndvi-node-battery-badge';
    let badge2 = document.getElementById(badgeId);
    if (!badge2) {
      const card = document.querySelector('#ndviView .ndvi-mcard:first-child');
      if (card) { badge2 = document.createElement('div'); badge2.id = badgeId; badge2.style.cssText = 'font-size:11px;padding-left:8px;margin-top:4px;'; card.appendChild(badge2); }
    }
    if (badge2) {
      const bat = data.node_battery.toFixed(0), volt = (data.node_voltage || 0).toFixed(2);
      const chgTxt = data.node_charge_mode === 2 ? '✅ Pin đầy' : data.node_charge_mode === 1 ? '⚡ Đang sạc' : '🔋 Dùng pin';
      const col = bat < 20 ? '#dc3545' : bat < 50 ? '#fd7e14' : '#2d6a0f';
      badge2.innerHTML = `<span style="color:${col}">🔋 Node: ${bat}% (${volt}V) — ${chgTxt}</span>`;
    }
  }
}

// ========== CHART: realtime ==========
function ndviInitChart() {
  const dom = document.getElementById('ndviChart');
  if (!dom) return;
  if (ndviChart) { ndviChart.dispose(); ndviChart = null; }
  ndviChart = echarts.init(dom);
  ndviChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['S2-411', 'S2-412', 'Trung bình'], bottom: 0, textStyle: { fontSize: 11 } },
    grid: { top: 20, bottom: 40, left: 45, right: 10, containLabel: false },
    xAxis: { type: 'category', boundaryGap: false, data: [], axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: {
      type: 'value', min: -0.2, max: 1.0,
      axisLabel: { fontSize: 10 },
      splitArea: {
        show: true,
        areaStyle: { color: ['rgba(220,53,69,0.07)', 'rgba(253,126,20,0.07)', 'rgba(139,195,74,0.07)', 'rgba(45,106,15,0.07)'] }
      }
    },
    series: [
      { name: 'S2-411', type: 'line', smooth: true, data: [], lineStyle: { color: '#dc3545', width: 2 }, itemStyle: { color: '#dc3545' }, showSymbol: false },
      { name: 'S2-412', type: 'line', smooth: true, data: [], lineStyle: { color: '#0d6efd', width: 2 }, itemStyle: { color: '#0d6efd' }, showSymbol: false },
      { name: 'Trung bình', type: 'line', smooth: true, data: [], lineStyle: { color: '#2d6a0f', width: 1.5, type: 'dashed' }, itemStyle: { color: '#2d6a0f' }, showSymbol: false }
    ]
  });
  window.addEventListener('resize', () => { if (ndviChart) ndviChart.resize(); });
}

function ndviUpdateChartRealtime() {
  if (!ndviChart || ndviDataStore.length === 0) return;
  ndviChart.setOption({
    xAxis: { data: ndviDataStore.map(d => d.timestamp) },
    series: [
      { data: ndviDataStore.map(d => +d.n411.toFixed(4)) },
      { data: ndviDataStore.map(d => +d.n412.toFixed(4)) },
      { data: ndviDataStore.map(d => +d.avg.toFixed(4)) }
    ]
  });
  // trend
  if (ndviDataStore.length > 1) {
    const last = ndviDataStore[ndviDataStore.length - 1].avg;
    const prev = ndviDataStore[ndviDataStore.length - 2].avg;
    const trend = last > prev ? '↑ Tăng' : last < prev ? '↓ Giảm' : '→ Ổn định';
    const col = last > prev ? '#2d6a0f' : last < prev ? '#dc3545' : '#6c757d';
    const el = document.getElementById('ndvi-trend-text');
    if (el) el.innerHTML = `Xu hướng: <span style="color:${col};font-weight:500;">${trend}</span>`;
  }
}

// ========== CHART: lịch sử từ SD ==========
async function ndviLoadHistoryChart(range) {
  const loading = document.getElementById('ndvi-loading');
  const chartDom = document.getElementById('ndviChart');
  if (loading) loading.style.display = 'block';
  if (chartDom) chartDom.style.visibility = 'hidden';

  try {
    const history = await getNDVIHistoryFromSD(range);
    if (loading) loading.style.display = 'none';
    if (chartDom) chartDom.style.visibility = 'visible';

    if (!history || !history.timestamps || history.timestamps.length === 0) {
      if (ndviChart) ndviChart.setOption({ xAxis: { data: [] }, series: [{ data: [] }, { data: [] }, { data: [] }] });
      showToast('Không có dữ liệu NDVI trong khoảng thời gian này', 'warning');
      return;
    }

    // Với range tuần/tháng: group theo ngày, tính trung bình
    let labels, d411, d412, dAvg;
    if (range === 'today') {
      labels = history.timestamps;
      d411 = history.ndvi411.map(v => +v.toFixed(4));
      d412 = history.ndvi412.map(v => +v.toFixed(4));
      dAvg = history.ndviTB.map(v => +v.toFixed(4));
    } else {
      // Group theo ngày
      const dayMap = new Map();
      history.timestamps.forEach((ts, i) => {
        let dateKey;
        if (ts.includes('/')) {
          const parts = ts.split(' ')[0].split('/');
          if (parts.length === 3) {
            const [m, d, y] = parts;
            dateKey = `${d.padStart(2,'0')}/${m.padStart(2,'0')}`;
          } else dateKey = ts.split(' ')[0];
        } else dateKey = ts.slice(5, 10).replace('-', '/');

        if (!dayMap.has(dateKey)) dayMap.set(dateKey, { n411: [], n412: [], avg: [] });
        const entry = dayMap.get(dateKey);
        entry.n411.push(history.ndvi411[i]);
        entry.n412.push(history.ndvi412[i]);
        entry.avg.push(history.ndviTB[i]);
      });
      const days = Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      labels = days.map(d => d[0]);
      const avg1d = arr => +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4);
      d411 = days.map(d => avg1d(d[1].n411));
      d412 = days.map(d => avg1d(d[1].n412));
      dAvg = days.map(d => avg1d(d[1].avg));
    }

    if (ndviChart) {
      ndviChart.setOption({
        xAxis: { data: labels },
        series: [{ data: d411 }, { data: d412 }, { data: dAvg }]
      });
    }

    // Trend
    if (dAvg.length > 1) {
      const last = dAvg[dAvg.length - 1], prev = dAvg[dAvg.length - 2];
      const trend = last > prev ? '↑ Tăng' : last < prev ? '↓ Giảm' : '→ Ổn định';
      const col = last > prev ? '#2d6a0f' : last < prev ? '#dc3545' : '#6c757d';
      const el = document.getElementById('ndvi-trend-text');
      if (el) el.innerHTML = `Xu hướng: <span style="color:${col};font-weight:500;">${trend}</span>`;
    }

  } catch (err) {
    if (loading) loading.style.display = 'none';
    if (chartDom) chartDom.style.visibility = 'visible';
    console.error('Lỗi tải NDVI lịch sử:', err);
    showToast('Lỗi tải dữ liệu lịch sử NDVI', 'error');
  }
}

// ========== LỊCH SỬ 7 NGÀY (bảng mini) ==========
async function ndviLoad7DayHistory() {
  const el = document.getElementById('ndvi-history-list');
  const avgEl = document.getElementById('ndvi-week-avg');
  if (!el) return;

  try {
    const history = await getNDVIHistoryFromSD('week');
    if (!history || history.timestamps.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:#adb5bd;font-size:12px;padding:10px;">Chưa có dữ liệu</div>';
      return;
    }

    // Group theo ngày
    const dayMap = new Map();
    history.timestamps.forEach((ts, i) => {
      let dateKey;
      if (ts.includes('/')) {
        const parts = ts.split(' ')[0].split('/');
        if (parts.length === 3) {
          const [m, d, y] = parts;
          dateKey = `${d.padStart(2,'0')}/${m.padStart(2,'0')}`;
        } else dateKey = ts.split(' ')[0];
      } else {
        const raw = ts.slice(0, 10);
        const [y, m, d] = raw.split('-');
        dateKey = `${d}/${m}`;
      }
      if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
      dayMap.get(dateKey).push(history.ndviTB[i]);
    });

    const days = Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-7)
      .reverse();

    let html = '';
    const allAvgs = days.map(d => d[1].reduce((a, b) => a + b, 0) / d[1].length);

    days.forEach(([date, vals], idx) => {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const prevAvg = idx < days.length - 1 ? (days[idx + 1][1].reduce((a, b) => a + b, 0) / days[idx + 1][1].length) : avg;
      const trend = avg > prevAvg + 0.005 ? '<span style="color:#2d6a0f;">↑</span>' : avg < prevAvg - 0.005 ? '<span style="color:#dc3545;">↓</span>' : '<span style="color:#6c757d;">→</span>';
      const health = ndviGetHealthInfo(avg);
      html += `<div class="ndvi-hist-row">
        <span style="color:#6c757d;">${date}</span>
        <span style="font-weight:500;color:${health.color};">${avg.toFixed(4)} ${trend}</span>
      </div>`;
    });

    el.innerHTML = html;

    const weekAvg = allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length;
    if (avgEl) { avgEl.textContent = weekAvg.toFixed(4); avgEl.style.color = ndviGetHealthInfo(weekAvg).color; }

  } catch (err) {
    el.innerHTML = '<div style="text-align:center;color:#adb5bd;font-size:12px;padding:10px;">Lỗi tải dữ liệu</div>';
    console.error('ndviLoad7DayHistory error:', err);
  }
}

// ========== SWITCH MODE ==========
function ndviSwitchMode(mode) {
  ndviCurrentMode = mode;
  const btns = ['realtime', 'today', 'week', 'month'];
  btns.forEach(b => {
    const el = document.getElementById('ndviBtn' + b.charAt(0).toUpperCase() + b.slice(1));
    if (el) el.classList.toggle('active', b === mode);
  });

  const modeBadge = document.getElementById('ndvi-mode-badge');
  const labels = { realtime: '● Real-time', today: '📅 Hôm nay', week: '📆 Tuần này', month: '🗓️ Tháng này' };
  if (modeBadge) modeBadge.textContent = labels[mode] || mode;

  if (mode === 'realtime') {
    isRealtimeMode = true;
    if (ndviInterval) { clearInterval(ndviInterval); ndviInterval = null; }
    if (ndviDataStore.length > 0) {
      ndviUpdateChartRealtime();
    } else {
      if (ndviChart) ndviChart.setOption({ xAxis: { data: [] }, series: [{ data: [] }, { data: [] }, { data: [] }] });
    }
    if (lastNDVIData) updateNDVIPage(lastNDVIData);
    ndviInterval = setInterval(async () => { await fetchNDVIFromGateway(); }, 30000);
  } else {
    isRealtimeMode = false;
    if (ndviInterval) { clearInterval(ndviInterval); ndviInterval = null; }
    ndviLoadHistoryChart(mode);
  }
}

// ========== SHOW NDVI PAGE ==========
async function showNDVI() {
  if (!requireLoginForStationDetail()) return;
  if (ndviInterval) { clearInterval(ndviInterval); ndviInterval = null; }
  if (allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);

  hideAllViews();
  const ndviPage = document.getElementById('ndviView');
  if (!ndviPage) return;
  ndviPage.style.display = 'block';

  // Khởi tạo chart
  setTimeout(() => {
    ndviInitChart();
    // Vào real-time mặc định
    ndviSwitchMode('realtime');
    // Load lịch sử 7 ngày bảng mini
    ndviLoad7DayHistory();
    // Nếu có data sẵn thì render luôn
    if (lastNDVIData) updateNDVIPage(lastNDVIData);
  }, 150);

  updateNavActive('ndviView');
}

// ========== CÁC HÀM GIỮ TƯƠNG THÍCH NGƯỢC ==========
function initNDVIChart() { ndviInitChart(); }
function updateNDVIChartFromStore() { ndviUpdateChartRealtime(); }
function clearRealtimeData() {
  ndviDataStore = [];
  if (ndviChart) ndviChart.setOption({ xAxis: { data: [] }, series: [{ data: [] }, { data: [] }, { data: [] }] });
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
function getAgriAdvice(tempMax, tempMin, avgHumidity, maxWind, totalRain) {
  const tips = [];
  if (totalRain >= 10) tips.push({ icon: '🌧️', text: 'Mưa đủ — không cần tưới', color: '#0d6efd' });
  else if (totalRain > 0 && totalRain < 10) tips.push({ icon: '🌦️', text: 'Mưa nhẹ — tưới bổ sung nếu đất khô', color: '#6c757d' });
  else if (avgHumidity < 50) tips.push({ icon: '💧', text: 'Khô — tưới sáng sớm hoặc chiều mát', color: '#fd7e14' });
  else tips.push({ icon: '💧', text: 'Độ ẩm ổn — theo dõi ẩm độ đất', color: '#198754' });
  if (totalRain > 20) tips.push({ icon: '🚫', text: 'Mưa to — không bón phân (dễ rửa trôi)', color: '#dc3545' });
  else if (tempMax >= 25 && tempMax <= 33 && totalRain < 5) tips.push({ icon: '✅', text: 'Thích hợp bón phân hôm nay', color: '#198754' });
  else if (tempMax > 35) tips.push({ icon: '⚠️', text: 'Nắng gắt — bón phân sáng sớm hoặc chiều', color: '#fd7e14' });
  if (maxWind > 5) tips.push({ icon: '💨', text: 'Gió > 5m/s — không phun thuốc/phân lá', color: '#dc3545' });
  else if (totalRain > 5) tips.push({ icon: '🌂', text: 'Có mưa — hoãn phun thuốc', color: '#fd7e14' });
  else if (maxWind <= 3 && totalRain < 2) tips.push({ icon: '✅', text: 'Thích hợp phun thuốc/phân lá', color: '#198754' });
  if (tempMax > 38) tips.push({ icon: '🌡️', text: 'Nắng cực đoan — phủ gốc, tưới 2 lần/ngày', color: '#dc3545' });
  else if (tempMin < 18) tips.push({ icon: '🥶', text: 'Đêm lạnh — che phủ cây con nếu cần', color: '#0dcaf0' });
  return tips;
}

// ================================
// AI CHAT
// ================================
function showAIChat() {
  if (!requireLoginForStationDetail()) return;
  if (typeof allChartsRefreshTimer !== 'undefined' && allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (typeof refreshTimer !== 'undefined' && refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  const view = document.getElementById('aiChatView');
  if (view) {
    view.style.display = 'flex';
    document.getElementById('aiChatInput')?.focus();
  }
}

function clearAIChat() {
  if (typeof aiChatHistory !== 'undefined') aiChatHistory = [];
  const msgs = document.getElementById('aiChatMessages');
  if (!msgs) return;
  msgs.innerHTML = `<div class="text-center text-muted py-4">
    <i class="fas fa-robot fa-2x mb-2 d-block text-success opacity-50"></i>
    <div class="fw-bold">Chat đã xóa. Hãy đặt câu hỏi mới!</div>
  </div>`;
}

function buildSensorContext() {
  if (typeof stations === 'undefined' || !stations || stations.length === 0) return 'Chua co du lieu.';
  let ctx = '=== DU LIEU CAM BIEN ===\n';
  stations.slice(0,6).forEach(s => {
    const d = s.data;
    if (!d || d.length < 8) return;
    const ok = d[0]!==0||d[1]!==0||d[2]!==0||d[3]!==0;
    ctx += `[${s.name}]: `;
    ctx += ok ? `pH=${d[0]}, VWC=${d[1]}%, EC=${d[2]}dS/m, T=${d[3]}C, Pin=${parseFloat(d[7]).toFixed(0)}%\n` : '[Chua co tin hieu]\n';
  });
  if (typeof lastNDVIData !== 'undefined' && lastNDVIData && lastNDVIData.valid)
    ctx += `NDVI=${lastNDVIData.ndvi.toFixed(4)}\n`;
  return ctx;
}

function appendAIMsg(role, text) {
  const msgs = document.getElementById('aiChatMessages');
  if (!msgs) return;
  msgs.querySelector('.text-center.text-muted')?.remove();
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.className = 'd-flex mb-2 ' + (isUser ? 'justify-content-end' : 'justify-content-start');
  div.innerHTML = `<div style="max-width:85%;padding:10px 14px;font-size:0.88rem;line-height:1.6;white-space:pre-wrap;
    ${isUser ? 'background:#0d6efd;color:white;border-radius:18px 18px 4px 18px;'
             : 'background:white;color:#212529;border-radius:18px 18px 18px 4px;border:1px solid #e2e8f0;'}"
  >${isUser ? '' : '<i class="fas fa-robot text-success me-1"></i>'}${text}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

let aiChatHistory = [];

async function sendAIMessage(question) {
  const input = document.getElementById('aiChatInput');
  const btn = document.getElementById('aiSendBtn');
  const text = question || (input && input.value.trim());
  if (!text) return;
  if (input) input.value = '';
  if (btn) btn.disabled = true;
  appendAIMsg('user', text);
  const msgs = document.getElementById('aiChatMessages');
  const typing = document.createElement('div');
  typing.id = 'aiTyping';
  typing.className = 'd-flex justify-content-start mb-2';
  typing.innerHTML = `<div style="background:white;border:1px solid #e2e8f0;border-radius:18px;padding:10px 16px;color:#6c757d;font-size:0.85rem;"><i class="fas fa-robot text-success me-1"></i> Đang phân tích...</div>`;
  if (msgs) { msgs.appendChild(typing); msgs.scrollTop = msgs.scrollHeight; }
  aiChatHistory.push({ role: 'user', content: buildSensorContext() + '\n\nCau hoi: ' + text });
  if (aiChatHistory.length > 20) aiChatHistory = aiChatHistory.slice(-20);
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: 'Ban la chuyen gia nong nghiep AI MIA. Phan tich du lieu cam bien va dua ra khuyen nghi cu the.', messages: aiChatHistory })
    });
    document.getElementById('aiTyping')?.remove();
    if (res.status === 404) {
      appendAIMsg('assistant', '⚙️ Gateway chua co route /api/ai.\nUpload.');
    } else if (!res.ok) {
      const d = await res.json().catch(()=>({}));
      appendAIMsg('assistant', '❌ Loi ' + res.status + ': ' + (d.error||'Khong xac dinh'));
    } else {
      const data = await res.json();
      const reply = data.reply || '❌ Khong co phan hoi';
      aiChatHistory.push({ role: 'assistant', content: reply });
      appendAIMsg('assistant', reply);
    }
  } catch(err) {
    document.getElementById('aiTyping')?.remove();
    appendAIMsg('assistant', '❌ Khong ket noi duoc Gateway.\nKiem tra Gateway dang chay.');
  }
  if (btn) btn.disabled = false;
  if (input) input.focus();
}

function sendQuickQuestion(q) { sendAIMessage(q); }


function acvSetRange(range) {
  currentTimeRange = range;
  historicalCache = {};
  ['day','week','month'].forEach(r => {
    const b = document.getElementById('acv-btn-' + r);
    if (b) b.classList.toggle('active', r === range);
  });
  const tu = document.getElementById('acv-update-time');
  if (tu) tu.textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});
  renderAllCharts().then(() => acvUpdateSummary());
}

function acvUpdateSummary() {
  const active = stations.filter(s => s.data && s.data.length >= 8 &&
    (s.data[0]!==0 || s.data[1]!==0 || s.data[3]!==0));
  if (active.length === 0) return;
  const avg = (key) => (active.reduce((s,st) => s + parseFloat(st.data[key]||0), 0) / active.length).toFixed(1);
  const avgPh   = avg(0);
  const avgVwc  = avg(1);
  const avgEc   = (active.reduce((s,st) => s + parseFloat(st.data[2]||0),0)/active.length).toFixed(2);
  const avgTemp = avg(3);
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('acv-s-temp', avgTemp + '°C');
  set('acv-s-vwc',  avgVwc + '%');
  set('acv-s-ph',   avgPh);
  set('acv-s-ec',   avgEc + ' dS/m');
  const st = settings.stations;
  const bdg = (id, ok) => {
    const e = document.getElementById(id);
    if (!e) return;
    e.textContent = ok ? 'Bình thường' : 'Kiểm tra';
    e.className = ok ? 'acv-badge-ok' : 'acv-badge-warn';
  };
  bdg('acv-badge-temp', avgTemp >= st.tempMin && avgTemp <= st.tempMax);
  bdg('acv-badge-vwc',  avgVwc  >= st.humMin  && avgVwc  <= st.humMax);
  bdg('acv-badge-ph',   avgPh   >= st.phMin   && avgPh   <= st.phMax);
  bdg('acv-badge-ec',   true);
}

// ============================================================
// HƯỚNG DẪN: Paste toàn bộ đoạn này vào CUỐI file script.js
// ============================================================

// ==================== AI EXPERT CHAT ====================

let aixHistory    = [];
let aixProvider   = 'offline';
let aixCurrentSel = 'offline'; // option đang chọn trong UI

// ── Hiển thị trang AI ──
function showAIExpert() {
  if (!requireLoginForStationDetail()) return;
  if (typeof allChartsRefreshTimer !== 'undefined' && allChartsRefreshTimer) clearInterval(allChartsRefreshTimer);
  if (typeof refreshTimer !== 'undefined' && refreshTimer) clearInterval(refreshTimer);
  hideAllViews();
  const v = document.getElementById('aiExpertView');
  if (v) v.style.display = 'block';
  if (typeof updateNavActive === 'function') updateNavActive('aiExpertView');
  // Load config từ gateway
  aixLoadConfig();
}

// ── Load config từ /api/ai-config ──
async function aixLoadConfig() {
  try {
    const res  = await fetch('/api/ai-config');
    if (!res.ok) return;
    const data = await res.json();
    const provider = data.provider || 'offline';
    const key      = data.apiKey   || '';
    const model    = data.model    || '';
 
    // Lưu key thật vào sessionStorage để dùng khi save lại
    // (tránh mất key khi user không nhập lại)
    if (key) sessionStorage.setItem('aix_real_key', key);
 
    if (provider === 'groq') {
      aixSelectProvider('groq');
      const ki = document.getElementById('aix-groq-key');
      const mi = document.getElementById('aix-groq-model');
      // Hiển thị mask nhưng lưu key thật vào data attribute
      if (ki) {
        ki.value = key ? '••••••••••••••••' : '';
        if (key) ki.setAttribute('data-real-key', key);
      }
      if (mi && model) mi.value = model;
      aixProvider = 'groq';
 
    } else if (provider === 'anthropic' || provider === 'openai') {
      aixSelectProvider('paid');
      const pp = document.getElementById('aix-paid-provider');
      const ki = document.getElementById('aix-paid-key');
      const mi = document.getElementById('aix-paid-model');
      if (pp) pp.value = provider;
      if (ki) {
        ki.value = key ? '••••••••••••••••' : '';
        if (key) ki.setAttribute('data-real-key', key);
      }
      if (mi && model) mi.value = model;
      aixProvider = provider;
 
    } else {
      aixSelectProvider('offline');
      aixProvider = 'offline';
    }
 
    aixUpdateBadge(provider);
    if (provider !== 'offline' && key) {
      aixUpdateStatus('ok', `Đã cấu hình: ${provider} — key đã lưu`);
    }
 
  } catch(e) {
    console.warn('[AIX] Load config error:', e);
  }
}
 

// ── Chọn provider option ──
function aixSelectProvider(opt) {
  aixCurrentSel = opt;
  // Reset tất cả
  ['offline','groq','paid'].forEach(o => {
    const el = document.getElementById('aix-opt-' + o);
    if (el) el.className = 'aix-opt';
  });
  // Active option được chọn
  const sel = document.getElementById('aix-opt-' + opt);
  if (sel) sel.className = 'aix-opt sel-' + opt;
  // Ẩn/hiện section config
  const secGroq = document.getElementById('aix-sec-groq');
  const secPaid = document.getElementById('aix-sec-paid');
  if (secGroq) secGroq.className = 'aix-section' + (opt === 'groq' ? ' show' : '');
  if (secPaid) secPaid.className = 'aix-section' + (opt === 'paid' ? ' show' : '');
}

// ── Lưu config lên Gateway ──
async function aixSaveConfig(mode) {
  let provider, apiKey, model;
 
  if (mode === 'groq') {
    provider = 'groq';
    const ki = document.getElementById('aix-groq-key');
    const mi = document.getElementById('aix-groq-model');
    // Nếu user nhập key mới thì dùng, nếu còn mask thì lấy key thật từ data-attribute
    const rawVal = ki ? ki.value.trim() : '';
    if (rawVal && !rawVal.startsWith('•')) {
      apiKey = rawVal; // key mới user vừa nhập
    } else {
      apiKey = (ki && ki.getAttribute('data-real-key')) || sessionStorage.getItem('aix_real_key') || '';
    }
    model = mi ? mi.value : 'llama-3.1-8b-instant';
    if (!apiKey) {
      alert('Vui lòng nhập Groq API key!');
      return;
    }
 
  } else if (mode === 'paid') {
    const pp = document.getElementById('aix-paid-provider');
    const ki = document.getElementById('aix-paid-key');
    const mi = document.getElementById('aix-paid-model');
    provider = pp ? pp.value : 'anthropic';
    const rawVal = ki ? ki.value.trim() : '';
    if (rawVal && !rawVal.startsWith('•')) {
      apiKey = rawVal;
    } else {
      apiKey = (ki && ki.getAttribute('data-real-key')) || sessionStorage.getItem('aix_real_key') || '';
    }
    model = mi ? mi.value : '';
    if (!apiKey) {
      alert('Vui lòng nhập API key!');
      return;
    }
 
  } else {
    // Offline
    provider = 'offline'; apiKey = ''; model = '';
  }
 
  try {
    const res = await fetch('/api/ai-config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ provider, apiKey, model })
    });
    if (res.ok) {
      // Lưu key thật vào sessionStorage và data-attribute
      if (apiKey) sessionStorage.setItem('aix_real_key', apiKey);
      const ki = document.getElementById(mode === 'groq' ? 'aix-groq-key' : 'aix-paid-key');
      if (ki) ki.setAttribute('data-real-key', apiKey);
 
      aixProvider = provider;
      aixUpdateBadge(provider);
      aixUpdateStatus('ok', `✅ Đã lưu lên Gateway — ${provider}`);
      if (typeof showToast === 'function')
        showToast('✅ Đã lưu cấu hình AI lên Gateway', 'success');
    } else {
      const err = await res.text();
      aixUpdateStatus('err', 'Lỗi lưu config: ' + err);
    }
  } catch(e) {
    aixUpdateStatus('err', 'Không kết nối được Gateway');
  }
}
 

// ── Test kết nối API ──
async function aixTest() {
  aixUpdateStatus('off', 'Đang test kết nối...');
  try {
    const res  = await fetch('/api/ai-test', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      aixUpdateStatus('ok', '✅ ' + (data.reply || 'Kết nối thành công!'));
    } else {
      aixUpdateStatus('err', '❌ ' + (data.reply || 'Kết nối thất bại'));
    }
  } catch(e) {
    aixUpdateStatus('err', '❌ Không kết nối được Gateway');
  }
}

// ── Cập nhật badge provider ──
function aixUpdateBadge(provider) {
  const badge = document.getElementById('aix-badge');
  const hint  = document.getElementById('aix-hint');
  if (!badge) return;
  const map = {
    offline:   { cls: 'aix-badge-offline',   txt: 'Offline' },
    groq:      { cls: 'aix-badge-groq',       txt: 'Groq Free' },
    anthropic: { cls: 'aix-badge-anthropic',  txt: 'Claude' },
    openai:    { cls: 'aix-badge-openai',     txt: 'GPT' },
  };
  const info = map[provider] || map['offline'];
  badge.className = 'aix-provider-badge ' + info.cls;
  badge.textContent = info.txt;
  if (hint) {
    hint.textContent = provider === 'offline'
      ? 'Offline mode · Phân tích rule-based từ dữ liệu cảm biến'
      : 'Dữ liệu cảm biến gửi kèm · ESP32 proxy qua ' + info.txt;
  }
}

// ── Cập nhật status chip ──
function aixUpdateStatus(state, msg) {
  const chip = document.getElementById('aix-status-main');
  const txt  = document.getElementById('aix-status-text');
  if (!chip || !txt) return;
  chip.className = 'aix-status aix-status-' + state;
  const dot = chip.querySelector('.aix-sdot');
  if (dot) dot.className = 'aix-sdot aix-sdot-' + state;
  txt.textContent = msg;
}

// ── Thêm message vào chat ──
function aixAppendMsg(role, text) {
  const box = document.getElementById('aix-messages');
  if (!box) return;
  // Xóa welcome nếu còn
  const welcome = box.querySelector('.aix-bubble-ai');
  if (welcome && welcome.closest('.aix-msg-ai') && aixHistory.length === 0) {
    // giữ nguyên
  }
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.className = isUser ? 'aix-msg-user' : 'aix-msg-ai';
  if (isUser) {
    div.innerHTML = `<div class="aix-bubble-user">${text}</div>`;
  } else {
    const now = new Date().toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'});
    div.innerHTML = `
      <div class="aix-avatar" style="width:26px;height:26px;font-size:13px;flex-shrink:0;">🌾</div>
      <div>
        <div class="aix-msg-lbl">Chuyên gia AI · ${now}</div>
        <div class="aix-bubble-ai">${text}</div>
      </div>`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Hiện typing indicator ──
function aixShowTyping() {
  const box = document.getElementById('aix-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.id = 'aix-typing';
  div.className = 'aix-msg-ai';
  div.innerHTML = `
    <div class="aix-avatar" style="width:26px;height:26px;font-size:13px;flex-shrink:0;">🌾</div>
    <div class="aix-bubble-ai" style="padding:10px 14px;">
      <div class="aix-typing">
        <div class="aix-dot"></div>
        <div class="aix-dot"></div>
        <div class="aix-dot"></div>
      </div>
    </div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function aixHideTyping() {
  const t = document.getElementById('aix-typing');
  if (t) t.remove();
}

// ── Xây dựng context cảm biến ──
// =============================================================
// HƯỚNG DẪN ÁP DỤNG:
// Tìm hàm: function aixBuildContext()
// Thay THẾ từ hàm đó đến hết hàm aixSend() bằng toàn bộ file này
// (giữ nguyên các hàm khác như aixLoadConfig, aixSaveConfig, v.v.)
// =============================================================


// ── Phân loại câu hỏi ──
function aixClassifyQuestion(text) {
  const t = text.toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd');

  // Từ khóa liên quan hệ thống nông nghiệp/cảm biến
  const agriKeywords = [
    'tuoi', 'bon', 'phan', 'ph', 'ec', 'vwc', 'ndvi', 'do am', 'nhiet do',
    'tram', 'cam bien', 'node', 'pin', 'sac', 'lora', 'gateway',
    'canh bao', 'bat thuong', 'ket noi', 'tin hieu', 'du lieu',
    'cay', 'dat', 'nuoc', 'phat trien', 'benh', 'sau', 'nang suat',
    'bao cao', 'tong hop', 'phan tich', 'khuyen nghi', 'suc khoe',
    'nir', 'red', 'anh sang', 'quang hop', 'diet chat', 'do dan dien',
    'nhiet', 'am', 'muon', 'nen', 'co nen', 'bao nhieu', 'nhu the nao',
    'kiem tra', 'xem', 'cho biet', 'tinh trang', 'hien tai'
  ];

  // Câu hỏi ngoài lề rõ ràng
  const offTopicKeywords = [
    'toan', 'tich phan', 'vi phan', 'vat ly', 'hoa hoc', 'lich su',
    'the thao', 'bong da', 'phim', 'nhac', 'nau an', 'cong thuc nau',
    'du lich', 'khach san', 'may bay', 'tien', 'chung khoan', 'bitcoin',
    'lap trinh', 'code', 'python', 'javascript', 'html', 'sql',
    'chinh tri', 'bau cu', 'tin tuc', 'bao', 'thoi su',
    'tieng anh', 'dich thuat', 'ngoai ngu'
  ];

  const hasAgri    = agriKeywords.some(k => t.includes(k));
  const hasOffTopic = offTopicKeywords.some(k => t.includes(k));

  if (hasOffTopic && !hasAgri) return 'off_topic';
  if (hasAgri)                 return 'agri';
  return 'general'; // câu hỏi chung, vẫn trả lời nhưng nhẹ nhàng
}


// ── Build system prompt thông minh ──
function aixBuildSystemPrompt(questionType) {
  const basePersona = `Bạn là MIA Assistant - trợ lý nông nghiệp thông minh của hệ thống quan trắc đất MIA (Monitoring Intelligence Agriculture).

THÔNG TIN VỀ BẢN THÂN:
- Tên: MIA Assistant
- Vai trò: Chuyên gia phân tích dữ liệu cảm biến đất và tư vấn canh tác
- Nhà phát triển: Nhóm nghiên cứu MIA
- KHÔNG đề cập đến ESP32, Arduino, vi điều khiển, hay phần cứng
- KHÔNG tự giới thiệu là AI của hãng nào (Groq, Anthropic, OpenAI...)
- Luôn xưng "tôi" và gọi người dùng là "bạn"`;

  const agriExpertise = `
CHUYÊN MÔN CỦA BẠN:
- Phân tích pH đất, độ ẩm thể tích (VWC), độ dẫn điện (EC), nhiệt độ đất
- Đọc và giải thích chỉ số NDVI từ cảm biến S2-411 (hướng lên - đo ánh sáng tới) và S2-412 (hướng xuống - đo phản xạ cây)
- Tư vấn tưới nước, bón phân, phòng trừ sâu bệnh dựa trên dữ liệu thực tế
- Cảnh báo bất thường từ các trạm cảm biến
- Kết hợp dữ liệu tự động (cảm biến) với dữ liệu phân tích tay (N, P, K, Ca, Mg...)`;

  const responseRules = `
QUY TẮC TRẢ LỜI:
1. Trả lời NGẮN GỌN, TỐI ĐA 300 từ, dùng tiếng Việt tự nhiên
2. ƯU TIÊN dữ liệu thực tế từ cảm biến - nếu không có dữ liệu thì nói rõ "chưa nhận được tín hiệu"
3. Khi có dữ liệu: đưa ra nhận xét CỤ THỂ (không nói chung chung)
4. Khi KHÔNG có dữ liệu: giải thích ngắn lý do có thể và hướng xử lý
5. KHÔNG bịa đặt số liệu, KHÔNG phân tích dữ liệu = 0 như thể có dữ liệu thật
6. Dùng emoji ít thôi: ✅ ⚠️ 💧 🌱 là đủ
7. KHÔNG dùng bảng markdown phức tạp khi dữ liệu trống
8. Câu trả lời phải HÀNH ĐỘNG ĐƯỢC - người dùng biết phải làm gì tiếp theo`;

  if (questionType === 'off_topic') {
    return `${basePersona}

${responseRules}

QUAN TRỌNG: Câu hỏi này NẰM NGOÀI chuyên môn của bạn.
Hãy lịch sự từ chối và hướng người dùng về chủ đề nông nghiệp/cảm biến.
Ví dụ: "Câu hỏi này ngoài phạm vi chuyên môn của tôi. Tôi chỉ hỗ trợ về phân tích đất, tưới tiêu, bón phân và giám sát cây trồng. Bạn muốn hỏi gì về hệ thống quan trắc không?"`;
  }

  return `${basePersona}
${agriExpertise}
${responseRules}`;
}


// ── Build context cảm biến ──
function aixBuildContext() {
  if (typeof stations === 'undefined' || !stations || stations.length === 0)
    return 'Chưa có dữ liệu từ các trạm cảm biến.';

  let onlineCount = 0;
  let ctx = '=== DỮ LIỆU CẢM BIẾN THỰC TẾ ===\n';
  ctx += `Thời điểm: ${new Date().toLocaleString('vi-VN')}\n\n`;

  // 6 trạm đất
  ctx += '[TRẠM ĐẤT - Cảm biến pH, VWC, EC, Nhiệt độ]\n';
  stations.slice(0, 6).forEach((s, i) => {
    const d = s.data;
    if (!d || d.length < 8) {
      ctx += `  Trạm ${i+1} (${s.name}): Chưa có tín hiệu\n`;
      return;
    }
    const hasData = d[0] !== 0 || d[1] !== 0 || d[3] !== 0;
    if (hasData) {
      onlineCount++;
      const bat     = parseFloat(d[7] || 0).toFixed(0);
      const chgText = d[8] === 2 ? 'Pin đầy' : d[8] === 1 ? 'Đang sạc' : 'Dùng pin';
      ctx += `  Trạm ${i+1} (${s.name}): pH=${d[0]} | VWC=${d[1]}% | EC=${d[2]} dS/m | Nhiệt độ đất=${d[3]}°C | Pin=${bat}% (${chgText})\n`;
    } else {
      ctx += `  Trạm ${i+1} (${s.name}): Chưa có tín hiệu\n`;
    }
  });

  ctx += `\nTổng trạm đất có tín hiệu: ${onlineCount}/6\n`;

  // Trạm 7 - NDVI (hoàn toàn khác loại)
  ctx += '\n[TRẠM 7 - Cảm biến ánh sáng & NDVI (đo sinh trưởng cây)]\n';
  ctx += 'Chú ý: S2-411 hướng LÊN đo ánh sáng mặt trời tới; S2-412 hướng XUỐNG đo ánh sáng phản xạ từ tán cây\n';

  const nd = (typeof lastNDVIData !== 'undefined') ? lastNDVIData : null;

  if (nd && nd.valid && (nd.S2_411.red !== 0 || nd.S2_411.nir !== 0)) {
    const r411 = nd.S2_411.red,  n411 = nd.S2_411.nir;
    const r412 = nd.S2_412.red,  n412 = nd.S2_412.nir;
    const nd411 = (n411 - r411) / ((n411 + r411) || 0.001);
    const nd412 = (n412 - r412) / ((n412 + r412) || 0.001);
    const avg   = (nd411 + nd412) / 2;

    let health = '';
    if      (avg < 0)   health = 'Giá trị âm - có thể đo mặt nước hoặc lỗi cảm biến';
    else if (avg < 0.2) health = 'Rất thấp - đất trống hoặc cây chết';
    else if (avg < 0.4) health = 'Thấp - cây phát triển yếu, cần can thiệp';
    else if (avg < 0.6) health = 'Trung bình - cây phát triển ở mức chấp nhận được';
    else                health = 'Tốt - cây phát triển khỏe mạnh';

    ctx += `  S2-411: RED=${r411.toFixed(4)} W/m²·nm | NIR=${n411.toFixed(4)} W/m²·nm | Góc=${nd.S2_411.angle.toFixed(1)}°\n`;
    ctx += `  S2-412: RED=${r412.toFixed(4)} W/m²·nm | NIR=${n412.toFixed(4)} W/m²·nm | Góc=${nd.S2_412.angle.toFixed(1)}°\n`;
    ctx += `  NDVI-411=${nd411.toFixed(4)} | NDVI-412=${nd412.toFixed(4)} | NDVI trung bình=${avg.toFixed(4)}\n`;
    ctx += `  Đánh giá sinh trưởng: ${health}\n`;
    if (nd.node_battery !== undefined) {
      ctx += `  Pin Trạm 7: ${nd.node_battery.toFixed(0)}%\n`;
    }
  } else {
    // Thử fallback từ mảng stations
    const ndviSt = stations.find(s =>
      s.isNDVI || s.id === 'NDVI_NODE' ||
      (typeof s.id === 'number' && s.id === 7)
    );
    if (ndviSt && ndviSt.data && ndviSt.data.length >= 7 &&
        (ndviSt.data[0] !== 0 || ndviSt.data[6] !== 0)) {
      const d = ndviSt.data;
      ctx += `  S2-411: RED=${d[0]} | NIR=${d[1]} | Góc=${d[2]}°\n`;
      ctx += `  S2-412: RED=${d[3]} | NIR=${d[4]} | Góc=${d[5]}°\n`;
      ctx += `  NDVI=${d[6]}\n`;
    } else {
      ctx += '  Chưa có tín hiệu từ Trạm 7\n';
    }
  }

  // Dữ liệu phân tích tay (N, P, K...) - nếu có
  // Đọc từ biến toàn cục nếu module manual data đã load
  if (typeof _mdLastManualSummary !== 'undefined' && _mdLastManualSummary) {
    ctx += '\n[DỮ LIỆU PHÂN TÍCH TAY GẦN NHẤT]\n';
    ctx += _mdLastManualSummary;
  }

  ctx += '\n=== KẾT THÚC DỮ LIỆU ===\n';
  return ctx;
}


// ── Gửi message ──
async function aixSend() {
  const inp = document.getElementById('aix-input');
  const btn = document.getElementById('aix-send-btn');
  if (!inp) return;

  const text = inp.value.trim();
  if (!text) return;

  inp.value = '';
  if (btn) { btn.disabled = true; }
  aixAppendMsg('user', text);

  // Phân loại câu hỏi
  const qType = aixClassifyQuestion(text);

  // Build system prompt theo loại câu hỏi
  const systemPrompt = aixBuildSystemPrompt(qType);

  // Build context cảm biến (chỉ thêm nếu câu hỏi liên quan nông nghiệp)
  let userContent = text;
  if (qType !== 'off_topic') {
    const ctx = aixBuildContext();
    userContent = ctx + '\n\nCâu hỏi của người dùng: ' + text;
  }

  // Thêm vào history (giới hạn 10 lượt để tránh token quá dài)
  aixHistory.push({ role: 'user', content: userContent });
  if (aixHistory.length > 10) aixHistory = aixHistory.slice(-10);

  aixShowTyping();

  try {
    // Gửi lên gateway - gateway sẽ forward tới Groq/Claude/GPT
    const payload = {
      system:   systemPrompt,
      messages: aixHistory
    };

    const res = await fetch('/api/ai', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    aixHideTyping();

    if (res.status === 404) {
      aixAppendMsg('assistant',
        '⚙️ Chưa kết nối được Gateway.\nVui lòng kiểm tra thiết bị MIA đang hoạt động và kết nối WiFi.');
      return;
    }

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      aixAppendMsg('assistant',
        `⚠️ Lỗi kết nối (${res.status}). Vui lòng thử lại sau.`);
      return;
    }

    const data     = await res.json();
    let   reply    = data.reply    || '❌ Không có phản hồi từ AI.';
    const provider = data.provider || 'offline';

    // Lưu vào history (chỉ lưu reply thuần, không có context)
    aixHistory.push({ role: 'assistant', content: reply });

    // Hiển thị
    aixAppendMsg('assistant', reply);

    // Cập nhật badge provider
    if (provider !== aixProvider) {
      aixProvider = provider;
      aixUpdateBadge(provider);
    }

  } catch(err) {
    aixHideTyping();
    console.error('[AIX] Send error:', err);
    aixAppendMsg('assistant',
      '❌ Không kết nối được Gateway MIA.\nKiểm tra thiết bị đang bật và WiFi hoạt động.');
  } finally {
    if (btn) btn.disabled = false;
    if (inp) inp.focus();
  }
}


// ── Gửi câu hỏi nhanh ──
function aixQuick(q) {
  const inp = document.getElementById('aix-input');
  if (inp) inp.value = q;
  aixSend();
}


// ── Xóa chat ──
function aixClearChat() {
  aixHistory = [];
  const box = document.getElementById('aix-messages');
  if (!box) return;
  box.innerHTML = `
    <div class="aix-msg-ai">
      <div class="aix-avatar" style="width:26px;height:26px;font-size:13px;flex-shrink:0;">🌾</div>
      <div>
        <div class="aix-msg-lbl">MIA Assistant · Sẵn sàng</div>
        <div class="aix-bubble-ai">Chat đã được xóa. Hãy đặt câu hỏi mới về hệ thống quan trắc của bạn!</div>
      </div>
    </div>`;
}

// =============================================================
// HƯỚNG DẪN ÁP DỤNG:
// 1. Tìm dòng:  // ==================== NHAP LIEU THU CONG ====================
// 2. Xóa từ đó đến hết hàm mdDeleteField() (hàm cuối cùng của module)
// 3. Paste toàn bộ nội dung file này vào thay thế
// =============================================================

// ==================== NHAP LIEU THU CONG ====================
let manualFields = [];
let _mdCurrentTab = 'entry'; // theo dõi tab hiện tại

// ------------------------------------------------------------------
// SHOW PAGE
// ------------------------------------------------------------------
async function showManualData() {
  if (!requireLoginForStationDetail()) return;
  if (typeof allChartsRefreshTimer !== 'undefined' && allChartsRefreshTimer)
    clearInterval(allChartsRefreshTimer);
  if (typeof refreshTimer !== 'undefined' && refreshTimer)
    clearInterval(refreshTimer);
  hideAllViews();

  let view = document.getElementById('manualDataView');
  if (!view) {
    view = document.createElement('div');
    view.id = 'manualDataView';
    document.querySelector('.main-content').appendChild(view);
  }
  view.style.display = 'block';
  view.innerHTML = `<div class="d-flex justify-content-center py-5">
    <div class="spinner-border text-success"></div></div>`;

  if (typeof updateNavActive === 'function') updateNavActive('manualDataView');

  await mdLoadFields();
  mdRender(view);
  mdAttachEvents(); // Gắn tất cả sự kiện sau khi render
}

// ------------------------------------------------------------------
// LOAD FIELDS TỪ GATEWAY
// ------------------------------------------------------------------
async function mdLoadFields() {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/manual-fields`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        manualFields = data;
        return;
      }
    }
  } catch(e) {
    console.warn('[ManualData] Cannot load fields from gateway:', e);
  }
  // Fallback mặc định nếu gateway không có
  if (manualFields.length === 0) {
    manualFields = [
      {id:'N',    name:'Đạm tổng số (N)',   unit:'mg/kg',    ref_min:20,  ref_max:80,  required:true},
      {id:'P',    name:'Lân dễ tiêu (P)',   unit:'mg/kg',    ref_min:5,   ref_max:25,  required:true},
      {id:'K',    name:'Kali trao đổi (K)', unit:'meq/100g', ref_min:0.2, ref_max:1.5, required:true},
      {id:'Ca',   name:'Canxi (Ca)',         unit:'meq/100g', ref_min:2,   ref_max:10,  required:false},
      {id:'Mg',   name:'Magie (Mg)',         unit:'meq/100g', ref_min:0.5, ref_max:3,   required:false},
      {id:'humus',name:'Hàm lượng mùn',     unit:'%',        ref_min:1,   ref_max:5,   required:false},
    ];
  }
}

// ------------------------------------------------------------------
// RENDER TOÀN BỘ TRANG (chỉ gọi 1 lần hoặc khi thật sự cần)
// ------------------------------------------------------------------
function mdRender(view) {
  if (!view) view = document.getElementById('manualDataView');
  if (!view) return;

  const today = new Date().toISOString().slice(0, 10);

  view.innerHTML = `
<style>
  .md-tab-btn{background:transparent;border:none;padding:7px 16px;font-size:13px;
    color:#6c757d;border-radius:8px;cursor:pointer;transition:all .15s}
  .md-tab-btn.active{background:#fff;color:#212529;font-weight:500;
    box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .md-sec{display:none}.md-sec.show{display:block}
  .md-card{background:#fff;border-radius:12px;border:1px solid #e9ecef;padding:1.25rem}
</style>

<!-- HEADER -->
<div class="d-flex align-items-center justify-content-between mb-3"
     style="flex-wrap:wrap;gap:8px">
  <div>
    <h5 class="mb-0 fw-500">
      <i class="fas fa-clipboard-list me-2 text-success"></i>Nhập liệu thủ công
    </h5>
    <div style="font-size:12px;color:#adb5bd;margin-top:2px">
      N, P, K và các chỉ tiêu phân tích đất khác
    </div>
  </div>
  <div style="display:flex;gap:4px;background:#f0f2f5;border-radius:10px;padding:3px">
    <button class="md-tab-btn active" id="md-btn-entry"
      onclick="mdTab('entry')">Nhập dữ liệu</button>
    <button class="md-tab-btn" id="md-btn-history"
      onclick="mdTab('history')">Lịch sử</button>
    <button class="md-tab-btn" id="md-btn-fields"
      onclick="mdTab('fields')">Quản lý trường</button>
  </div>
</div>

<!-- ===== TAB NHẬP ===== -->
<div id="md-entry" class="md-sec show">
  <div class="md-card">
    <div class="fw-500 mb-1">Phiếu nhập liệu</div>
    <div style="font-size:12px;color:#6c757d;margin-bottom:1rem">
      Điền thông tin mẫu và kết quả phân tích
    </div>

    <!-- Thông tin mẫu -->
    <div class="row mb-3 pb-3 border-bottom">
      <div class="col-md-4 mb-2">
        <label class="form-label" style="font-size:12px;color:#6c757d">Ngày lấy mẫu</label>
        <input type="date" class="form-control form-control-sm"
          id="md-date" value="${today}">
      </div>
      <div class="col-md-4 mb-2">
        <label class="form-label" style="font-size:12px;color:#6c757d">Tên / Mã mẫu *</label>
        <input type="text" class="form-control form-control-sm"
          id="md-label" placeholder="VD: Lô A1, Ruộng Bắc...">
      </div>
      <div class="col-md-4 mb-2">
        <label class="form-label" style="font-size:12px;color:#6c757d">Độ sâu lấy mẫu</label>
        <select class="form-select form-select-sm" id="md-depth">
          <option value="">Chọn độ sâu...</option>
          <option>0–20 cm</option>
          <option>20–40 cm</option>
          <option>40–60 cm</option>
          <option>Khác</option>
        </select>
      </div>
    </div>

    <!-- Các trường phân tích - render động -->
    <div class="row" id="md-fields-inputs">
      ${mdBuildFieldInputs()}
    </div>

    <!-- Ghi chú -->
    <label class="form-label" style="font-size:12px;color:#6c757d">Ghi chú</label>
    <input type="text" class="form-control form-control-sm mb-3"
      id="md-note" placeholder="VD: Lấy mẫu sau mưa 2 ngày...">

    <!-- Footer nút -->
    <div class="d-flex align-items-center justify-content-between pt-2 border-top">
      <div style="font-size:11px;color:#adb5bd">
        <i class="fas fa-sd-card me-1"></i>
        Ghi vào SD: manual-${today}.csv
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-sm btn-outline-secondary" id="md-clear-btn">
          <i class="fas fa-eraser me-1"></i>Xoá trắng
        </button>
        <button class="btn btn-sm btn-success" id="md-save-btn">
          <i class="fas fa-check me-1"></i>Lưu dữ liệu
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ===== TAB LỊCH SỬ ===== -->
<div id="md-history" class="md-sec">
  <div class="md-card">
    <div class="d-flex gap-2 mb-3 flex-wrap align-items-center">
      <input type="text" class="form-control form-control-sm"
        placeholder="Tìm tên mẫu..." style="width:160px" id="md-search">
      <input type="date" class="form-control form-control-sm"
        style="width:130px" id="md-from">
      <span style="color:#adb5bd">→</span>
      <input type="date" class="form-control form-control-sm"
        style="width:130px" id="md-to" value="${today}">
      <button class="btn btn-sm btn-outline-secondary" id="md-filter-btn">
        <i class="fas fa-search me-1"></i>Lọc
      </button>
    </div>
    <div id="md-hist-table">
      <div class="text-center text-muted py-4" style="font-size:13px">
        <i class="fas fa-spinner fa-spin me-2"></i>Đang tải...
      </div>
    </div>
  </div>
</div>

<!-- ===== TAB QUẢN LÝ TRƯỜNG ===== -->
<div id="md-fields" class="md-sec">
  <div class="row g-3">

    <!-- Danh sách trường hiện tại -->
    <div class="col-md-6">
      <div class="md-card p-0 overflow-hidden">
        <div class="d-flex align-items-center justify-content-between
             px-3 py-2 border-bottom" style="background:#f8f9fa">
          <span style="font-size:13px;font-weight:500">
            Trường hiện tại (<span id="md-field-count">${manualFields.length}</span>)
          </span>
        </div>
        <div id="md-field-list">
          ${mdBuildFieldList()}
        </div>
      </div>
    </div>

    <!-- Form thêm trường mới -->
    <div class="col-md-6">
      <div class="md-card">
        <div style="font-size:13px;font-weight:500;margin-bottom:1rem">
          <i class="fas fa-plus text-primary me-2"></i>Thêm trường mới
        </div>
        <div class="mb-2">
          <label class="form-label" style="font-size:12px;color:#6c757d">
            Tên hiển thị *
          </label>
          <input type="text" class="form-control form-control-sm"
            id="nf-name" placeholder="VD: Lưu huỳnh tổng số (S)">
        </div>
        <div class="row g-2 mb-2">
          <div class="col-6">
            <label class="form-label" style="font-size:12px;color:#6c757d">
              ID (dùng trong CSV) *
            </label>
            <input type="text" class="form-control form-control-sm"
              id="nf-id" placeholder="VD: S">
          </div>
          <div class="col-6">
            <label class="form-label" style="font-size:12px;color:#6c757d">
              Đơn vị *
            </label>
            <input type="text" class="form-control form-control-sm"
              id="nf-unit" placeholder="VD: mg/kg">
          </div>
        </div>
        <div class="row g-2 mb-3">
          <div class="col-6">
            <label class="form-label" style="font-size:12px;color:#6c757d">
              Tham chiếu thấp
            </label>
            <input type="number" class="form-control form-control-sm"
              id="nf-min" placeholder="VD: 10">
          </div>
          <div class="col-6">
            <label class="form-label" style="font-size:12px;color:#6c757d">
              Tham chiếu cao
            </label>
            <input type="number" class="form-control form-control-sm"
              id="nf-max" placeholder="VD: 100">
          </div>
        </div>
        <div class="form-check form-switch mb-3">
          <input class="form-check-input" type="checkbox" id="nf-req">
          <label class="form-check-label" style="font-size:13px" for="nf-req">
            Bắt buộc nhập
          </label>
        </div>

        <!-- Thông báo lỗi inline -->
        <div id="nf-error" style="display:none;color:#dc3545;font-size:12px;
          margin-bottom:8px;padding:6px 10px;background:#fde8e8;
          border-radius:6px;"></div>

        <button class="btn btn-primary btn-sm w-100" id="nf-add-btn">
          <i class="fas fa-plus me-1"></i>Thêm trường
        </button>
        <div class="alert alert-info py-2 px-3 mt-3 mb-0"
          style="font-size:12px">
          <i class="fas fa-robot me-1"></i>
          Trường mới tự xuất hiện trong form nhập và AI đọc được.
        </div>
      </div>
    </div>

  </div>
</div>`;

  // Gắn events ngay sau render
  mdAttachEvents();
  // Load lịch sử ngầm
  setTimeout(mdLoadHistory, 200);
}

// ------------------------------------------------------------------
// BUILD HTML CHO INPUT CÁC TRƯỜNG (dùng lại không re-render toàn trang)
// ------------------------------------------------------------------
function mdBuildFieldInputs() {
  if (!manualFields || manualFields.length === 0) {
    return '<div class="col-12 text-muted" style="font-size:13px">Chưa có trường nào.</div>';
  }
  return manualFields.map(f => `
    <div class="col-md-4 mb-3">
      <label class="form-label d-flex justify-content-between"
        style="font-size:12px;color:#6c757d">
        <span>${f.name}${f.required ? ' <span style="color:#dc3545">*</span>' : ''}</span>
        <span class="badge bg-light text-muted border"
          style="font-size:10px">${f.unit}</span>
      </label>
      <input type="number" step="any"
        class="form-control form-control-sm md-field-input"
        data-id="${f.id}" id="mdf-${f.id}"
        placeholder="${f.ref_min}">
      <div style="font-size:10px;color:#adb5bd;margin-top:2px">
        Tham chiếu: ${f.ref_min}–${f.ref_max} ${f.unit}
      </div>
    </div>`).join('');
}

// ------------------------------------------------------------------
// BUILD HTML DANH SÁCH TRƯỜNG HIỆN TẠI
// ------------------------------------------------------------------
function mdBuildFieldList() {
  if (!manualFields || manualFields.length === 0) {
    return '<div class="text-muted text-center py-3" style="font-size:13px">Chưa có trường nào.</div>';
  }
  return manualFields.map(f => `
    <div class="d-flex align-items-center gap-2 py-2 px-3 border-bottom md-field-item"
      data-fid="${f.id}" style="font-size:13px">
      <div class="flex-grow-1">
        <div style="font-weight:500">${f.name}</div>
        <div style="font-size:11px;color:#adb5bd">
          ID: ${f.id} · ${f.unit} · ${f.ref_min}–${f.ref_max}
        </div>
      </div>
      <span class="badge" style="font-size:10px;background:${f.required?'#d4edda':'#f8f9fa'};
        color:${f.required?'#155724':'#6c757d'}">
        ${f.required ? 'Bắt buộc' : 'Tuỳ chọn'}
      </span>
      <button class="btn btn-sm btn-link text-danger p-0 md-delete-field-btn"
        data-fid="${f.id}" title="Xóa trường này">
        <i class="fas fa-trash-alt" style="font-size:12px;pointer-events:none"></i>
      </button>
    </div>`).join('');
}

// ------------------------------------------------------------------
// ATTACH EVENTS - gắn 1 lần, dùng event delegation cho các item động
// ------------------------------------------------------------------
function mdAttachEvents() {
  // Nút Lưu dữ liệu
  const saveBtn = document.getElementById('md-save-btn');
  if (saveBtn) {
    saveBtn.onclick = null; // xóa handler cũ nếu có
    saveBtn.addEventListener('click', mdSave);
  }

  // Nút Xoá trắng
  const clearBtn = document.getElementById('md-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = null;
    clearBtn.addEventListener('click', mdClear);
  }

  // Nút Lọc lịch sử
  const filterBtn = document.getElementById('md-filter-btn');
  if (filterBtn) {
    filterBtn.onclick = null;
    filterBtn.addEventListener('click', mdLoadHistory);
  }

  // Nút Thêm trường
  const addBtn = document.getElementById('nf-add-btn');
  if (addBtn) {
    addBtn.onclick = null;
    addBtn.addEventListener('click', mdAddField);
  }

  // Event delegation cho nút Xóa trường trong danh sách
  const fieldList = document.getElementById('md-field-list');
  if (fieldList) {
    fieldList.onclick = function(e) {
      // Tìm button xóa gần nhất
      const btn = e.target.closest('.md-delete-field-btn');
      if (btn) {
        const fid = btn.getAttribute('data-fid');
        if (fid) mdDeleteField(fid);
      }
    };
  }
}

// ------------------------------------------------------------------
// CHUYỂN TAB
// ------------------------------------------------------------------
function mdTab(tabName) {
  _mdCurrentTab = tabName;
  // Ẩn tất cả section
  ['entry', 'history', 'fields'].forEach(t => {
    const sec = document.getElementById('md-' + t);
    const btn = document.getElementById('md-btn-' + t);
    if (sec) sec.classList.remove('show');
    if (btn) btn.classList.remove('active');
  });
  // Hiện section được chọn
  const activeSec = document.getElementById('md-' + tabName);
  const activeBtn = document.getElementById('md-btn-' + tabName);
  if (activeSec) activeSec.classList.add('show');
  if (activeBtn) activeBtn.classList.add('active');

  if (tabName === 'history') mdLoadHistory();
}

// ------------------------------------------------------------------
// XOÁ TRẮNG FORM NHẬP
// ------------------------------------------------------------------
function mdClear() {
  ['md-label', 'md-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const depthEl = document.getElementById('md-depth');
  if (depthEl) depthEl.value = '';
  document.querySelectorAll('.md-field-input').forEach(el => el.value = '');
  // Reset date về hôm nay
  const dateEl = document.getElementById('md-date');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// LƯU DỮ LIỆU - FIX CHÍNH
// ------------------------------------------------------------------
async function mdSave() {
  // Disable nút tránh double-click
  const saveBtn = document.getElementById('md-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Đang lưu...'; }

  try {
    const dateEl  = document.getElementById('md-date');
    const labelEl = document.getElementById('md-label');
    const depthEl = document.getElementById('md-depth');
    const noteEl  = document.getElementById('md-note');

    const date  = dateEl  ? dateEl.value  : new Date().toISOString().slice(0, 10);
    const label = labelEl ? labelEl.value.trim() : '';
    const depth = depthEl ? depthEl.value : '';
    const note  = noteEl  ? noteEl.value.trim() : '';

    if (!label) {
      showToast('Vui lòng nhập tên / mã mẫu', 'error');
      if (labelEl) labelEl.focus();
      return;
    }

    // Kiểm tra trường bắt buộc
    for (const f of manualFields) {
      if (f.required) {
        const el = document.getElementById('mdf-' + f.id);
        if (!el || el.value.trim() === '') {
          showToast(`Vui lòng nhập: ${f.name}`, 'error');
          if (el) el.focus();
          return;
        }
      }
    }

    // Gom giá trị các trường
    const values = {};
    manualFields.forEach(f => {
      const el = document.getElementById('mdf-' + f.id);
      if (el && el.value.trim() !== '') {
        values[f.id] = parseFloat(el.value);
      }
    });

    const payload = { date, label, depth, note, values };
    console.log('[mdSave] Payload:', JSON.stringify(payload));

    const res = await fetch(`${GATEWAY_URL}/api/manual-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log('[mdSave] Response status:', res.status);

    if (res.ok) {
      const result = await res.json().catch(() => ({}));
      showToast(`✅ Đã lưu: ${result.file || 'manual-' + date + '.csv'}`, 'success');
      mdClear();
      setTimeout(mdLoadHistory, 300);
    } else {
      const errText = await res.text().catch(() => 'Unknown error');
      console.error('[mdSave] Error:', res.status, errText);
      showToast(`Lỗi ${res.status}: ${errText}`, 'error');
    }

  } catch(e) {
    console.error('[mdSave] Exception:', e);
    showToast('Không kết nối được Gateway: ' + e.message, 'error');
  } finally {
    // Luôn re-enable nút dù thành công hay thất bại
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-check me-1"></i>Lưu dữ liệu';
    }
  }
}

// ------------------------------------------------------------------
// THÊM TRƯỜNG MỚI - FIX CHÍNH
// ------------------------------------------------------------------
async function mdAddField() {
  const addBtn  = document.getElementById('nf-add-btn');
  const errDiv  = document.getElementById('nf-error');

  // Hide lỗi cũ
  if (errDiv) errDiv.style.display = 'none';

  const nameEl  = document.getElementById('nf-name');
  const idEl    = document.getElementById('nf-id');
  const unitEl  = document.getElementById('nf-unit');
  const minEl   = document.getElementById('nf-min');
  const maxEl   = document.getElementById('nf-max');
  const reqEl   = document.getElementById('nf-req');

  const name = nameEl ? nameEl.value.trim() : '';
  const id   = idEl   ? idEl.value.trim().replace(/\s+/g, '_') : '';
  const unit = unitEl ? unitEl.value.trim() : '';
  const min  = parseFloat(minEl && minEl.value ? minEl.value : '0') || 0;
  const max  = parseFloat(maxEl && maxEl.value ? maxEl.value : '100') || 100;
  const req  = reqEl  ? reqEl.checked : false;

  // Validate
  const showErr = (msg) => {
    if (errDiv) { errDiv.textContent = msg; errDiv.style.display = 'block'; }
    else showToast(msg, 'error');
  };

  if (!name) { showErr('Vui lòng nhập Tên hiển thị'); if (nameEl) nameEl.focus(); return; }
  if (!id)   { showErr('Vui lòng nhập ID trường');    if (idEl)   idEl.focus();   return; }
  if (!unit) { showErr('Vui lòng nhập Đơn vị');       if (unitEl) unitEl.focus(); return; }
  if (manualFields.find(f => f.id === id)) {
    showErr(`ID "${id}" đã tồn tại. Dùng ID khác.`);
    if (idEl) idEl.focus();
    return;
  }

  // Disable nút tránh double submit
  if (addBtn) { addBtn.disabled = true; addBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Đang lưu...'; }

  const newField = { id, name, unit, ref_min: min, ref_max: max, required: req };
  manualFields.push(newField);
  console.log('[mdAddField] New field:', newField, '| Total:', manualFields.length);

  try {
    const res = await fetch(`${GATEWAY_URL}/api/manual-fields`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(manualFields)
    });

    console.log('[mdAddField] Save response:', res.status);

    if (res.ok) {
      showToast(`✅ Đã thêm trường "${name}"`, 'success');

      // Chỉ cập nhật 2 vùng DOM cần thiết, KHÔNG re-render toàn trang
      // 1. Cập nhật danh sách trường
      const fieldList = document.getElementById('md-field-list');
      if (fieldList) fieldList.innerHTML = mdBuildFieldList();

      // 2. Cập nhật counter
      const countEl = document.getElementById('md-field-count');
      if (countEl) countEl.textContent = manualFields.length;

      // 3. Cập nhật input trong tab nhập liệu
      const inputsContainer = document.getElementById('md-fields-inputs');
      if (inputsContainer) inputsContainer.innerHTML = mdBuildFieldInputs();

      // 4. Clear form thêm trường (KHÔNG re-render)
      if (nameEl)  nameEl.value  = '';
      if (idEl)    idEl.value    = '';
      if (unitEl)  unitEl.value  = '';
      if (minEl)   minEl.value   = '';
      if (maxEl)   maxEl.value   = '';
      if (reqEl)   reqEl.checked = false;
      if (errDiv)  errDiv.style.display = 'none';

      // 5. Re-attach event delegation cho danh sách trường mới
      const fl = document.getElementById('md-field-list');
      if (fl) {
        fl.onclick = function(e) {
          const btn = e.target.closest('.md-delete-field-btn');
          if (btn) {
            const fid = btn.getAttribute('data-fid');
            if (fid) mdDeleteField(fid);
          }
        };
      }

    } else {
      // Rollback nếu gateway lỗi
      manualFields.pop();
      const errText = await res.text().catch(() => 'Unknown');
      console.error('[mdAddField] Error:', res.status, errText);
      showErr(`Lỗi lưu lên Gateway (${res.status}): ${errText}`);
    }

  } catch(e) {
    // Rollback
    manualFields.pop();
    console.error('[mdAddField] Exception:', e);
    showErr('Không kết nối được Gateway: ' + e.message);
  } finally {
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.innerHTML = '<i class="fas fa-plus me-1"></i>Thêm trường';
    }
  }
}

// ------------------------------------------------------------------
// XÓA TRƯỜNG
// ------------------------------------------------------------------
async function mdDeleteField(fid) {
  const field = manualFields.find(f => f.id === fid);
  if (!field) { showToast('Không tìm thấy trường cần xóa', 'error'); return; }

  if (!confirm(`Xóa trường "${field.name}" (ID: ${fid})?\nDữ liệu đã lưu trong CSV không bị ảnh hưởng.`)) return;

  const backup = [...manualFields];
  manualFields = manualFields.filter(f => f.id !== fid);

  try {
    const res = await fetch(`${GATEWAY_URL}/api/manual-fields`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(manualFields)
    });

    if (res.ok) {
      showToast(`✅ Đã xóa trường "${field.name}"`, 'success');

      // Cập nhật UI mà không re-render toàn trang
      const fieldList = document.getElementById('md-field-list');
      if (fieldList) fieldList.innerHTML = mdBuildFieldList();

      const countEl = document.getElementById('md-field-count');
      if (countEl) countEl.textContent = manualFields.length;

      const inputsContainer = document.getElementById('md-fields-inputs');
      if (inputsContainer) inputsContainer.innerHTML = mdBuildFieldInputs();

      // Re-attach event delegation
      const fl = document.getElementById('md-field-list');
      if (fl) {
        fl.onclick = function(e) {
          const btn = e.target.closest('.md-delete-field-btn');
          if (btn) {
            const fid2 = btn.getAttribute('data-fid');
            if (fid2) mdDeleteField(fid2);
          }
        };
      }

    } else {
      manualFields = backup;
      showToast('Lỗi xóa trường trên Gateway', 'error');
    }
  } catch(e) {
    manualFields = backup;
    showToast('Không kết nối được Gateway: ' + e.message, 'error');
  }
}

// ------------------------------------------------------------------
// LOAD LỊCH SỬ TỪ SD
// ------------------------------------------------------------------
async function mdLoadHistory() {
  const el = document.getElementById('md-hist-table');
  if (!el) return;

  el.innerHTML = `<div class="text-center text-muted py-3" style="font-size:13px">
    <i class="fas fa-spinner fa-spin me-2"></i>Đang tải từ SD...</div>`;

  let rows = [];
  try {
    const filesRes = await fetch(`${GATEWAY_URL}/api/sd/files`);
    if (!filesRes.ok) throw new Error('Cannot get file list');
    const files = await filesRes.json();
    const mfiles = files
      .filter(f => f.startsWith('manual-') && f.endsWith('.csv'))
      .sort()
      .reverse()
      .slice(0, 5);

    for (const fname of mfiles) {
      try {
        const csv = await fetch(`${GATEWAY_URL}/api/sd/download?file=${encodeURIComponent(fname)}`).then(r => r.text());
        if (!csv || csv.trim().length === 0) continue;
        const lines = csv.trim().split('\n');
        if (lines.length < 2) continue;
        const headers = lines[0].split(',').map(h => h.trim());
        for (let i = lines.length - 1; i >= 1; i--) {
          if (!lines[i].trim()) continue;
          const vals = lines[i].split(',').map(v => v.trim());
          const obj = {};
          headers.forEach((h, j) => obj[h] = vals[j] || '');
          rows.push(obj);
        }
      } catch(e) {
        console.warn('[mdLoadHistory] Cannot read file:', fname, e);
      }
    }
  } catch(e) {
    console.warn('[mdLoadHistory] Error:', e);
  }

  if (rows.length === 0) {
    el.innerHTML = `<div class="text-center text-muted py-4" style="font-size:13px">
      <i class="fas fa-clipboard me-2"></i>Chưa có dữ liệu phân tích tay</div>`;
    return;
  }

  // Lọc theo search/date
  const search = (document.getElementById('md-search')?.value || '').toLowerCase();
  const from   = document.getElementById('md-from')?.value  || '';
  const to     = document.getElementById('md-to')?.value    || '';
  if (search) rows = rows.filter(r => (r['Ten mau'] || '').toLowerCase().includes(search));
  if (from)   rows = rows.filter(r => (r['Ngay lay mau'] || '') >= from);
  if (to)     rows = rows.filter(r => (r['Ngay lay mau'] || '') <= to);

  const fixed = ['Timestamp', 'Ngay lay mau', 'Ten mau', 'Do sau', 'Ghi chu'];
  const dynCols = Object.keys(rows[0] || {}).filter(k => !fixed.includes(k));

  const thead = dynCols.map(c => {
    const f = manualFields.find(f => f.id === c);
    return `<th style="font-size:12px;white-space:nowrap">
      ${f ? f.name.replace(/\(.*?\)/, '').trim() : c}
      <br><span style="font-weight:400;color:#adb5bd;font-size:10px">${f ? f.unit : ''}</span>
    </th>`;
  }).join('');

  const tbody = rows.slice(0, 50).map(r => {
    const cells = dynCols.map(c => {
      const v = r[c];
      if (!v || v === '') return '<td style="color:#dee2e6">—</td>';
      const n = parseFloat(v);
      const f = manualFields.find(f => f.id === c);
      const warn = f && !isNaN(n) && (n < f.ref_min || n > f.ref_max);
      return `<td style="${warn ? 'color:#dc3545;font-weight:500' : ''}">${isNaN(n) ? v : n.toFixed(2)}</td>`;
    }).join('');

    return `<tr>
      <td style="font-size:12px;color:#6c757d;white-space:nowrap">${r['Ngay lay mau'] || ''}</td>
      <td style="font-weight:500">${r['Ten mau'] || ''}</td>
      <td style="font-size:12px;color:#6c757d">${r['Do sau'] || '—'}</td>
      ${cells}
      <td style="font-size:11px;color:#adb5bd">${r['Ghi chu'] || '—'}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="overflow-x:auto">
      <table class="table table-sm mb-0" style="font-size:13px">
        <thead style="background:#f8f9fa">
          <tr>
            <th style="font-size:12px">Ngày</th>
            <th style="font-size:12px">Tên / Mã mẫu</th>
            <th style="font-size:12px">Độ sâu</th>
            ${thead}
            <th style="font-size:12px">Ghi chú</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:#adb5bd;padding:8px 4px">
      ${rows.length} bản ghi ·
      <span style="color:#dc3545">Màu đỏ</span> = ngoài ngưỡng tham chiếu
    </div>`;
}
