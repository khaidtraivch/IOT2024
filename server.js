const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ESP32_IP = '192.168.38.126';
const IMAGE_PATH = 'esp32cam.jpg';

const multer = require('multer');
const { spawn } = require('child_process');

const app = express();
const port = 3000;

// Cấu hình multer để lưu trữ tạm thời các tệp tải lên
const upload = multer({ dest: 'uploads/' });

app.use(bodyParser.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database('./swipe_data.db', (err) => {
    if (err) {
        console.error('Database Lỗi:', err);
    } else {
        console.log('Da ket noi toi SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS swipe_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cardUID TEXT,
            checkInTime TEXT,
            checkOutTime TEXT,
            vehicleType TEXT
        )`);

    }
});

app.post('/api/swipe', (req, res) => {
    const { cardUID, swipeTime, vehicleType } = req.body;

    if (cardUID && swipeTime) {
        db.get(`SELECT * FROM swipe_records WHERE cardUID = ? ORDER BY id DESC LIMIT 1`, [cardUID], (err, row) => {
            if (err) {
                return res.status(500).json({ message: 'Database error', error: err });
            }
            if (row && !row.checkOutTime) {
                // Nếu có bản ghi vào (check-in) chưa có thời gian ra, cập nhật checkOutTime
                db.run(`UPDATE swipe_records SET checkOutTime = ? WHERE id = ?`, [swipeTime, row.id], (err) => {
                    if (err) {
                        return res.status(500).json({ message: 'Database error', error: err });
                    }
                    res.status(200).json({ message: 'Check-out time ghi nhận thành công!', action: "OUT" });
                });
            } else {
                // Nếu không có bản ghi vào, tạo một bản ghi mới với thời gian vào
                db.run(`INSERT INTO swipe_records (cardUID, checkInTime, vehicleType) VALUES (?, ?, ?)`, [cardUID, swipeTime, vehicleType], (err) => {
                    if (err) {
                        return res.status(500).json({ message: 'Database error', error: err });
                    }
                    res.status(200).json({ message: 'Check-in time ghi nhận thành công!', action: "IN" });
                });
            }
        });
    } else {
        res.status(400).json({ message: 'Sai định dạng data' });
    }
});

app.get('/api/swipe_records', (req, res) => {
    db.all(`SELECT * FROM swipe_records`, (err, rows) => {
        if (err) {
            return res.status(500).json({ message: 'Database error', error: err });
        }
        res.status(200).json(rows);
    });
});

let irSensorStates = { slot1: 'Trống', slot2: 'Trống' };
app.get('/ir_sensor', (req, res) => {
    const sensorId = req.query.sensor;
    const state = req.query.state === '0' ? 'Có xe' : 'Trống';
    if (sensorId === '1') {
        irSensorStates['slot1'] = state;
    }

    else if (sensorId === '2') {
        irSensorStates['slot2'] = state;
    }

    console.log(`Cảm biến ${sensorId} trạng thái: ${state}`);
    res.sendStatus(200);
});

app.get('/get_ir_status', (req, res) => {
    res.json(irSensorStates);
});

async function captureImage() {
    try {
        const response = await axios.get(`http://${ESP32_IP}/take-picture`, {
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(IMAGE_PATH, response.data);
        console.log(`Ảnh đã được lưu thành công tại ${IMAGE_PATH}`);
    } catch (error) {
        console.error('Có lỗi xảy ra khi chụp ảnh:', error.message);
    }
}

app.get('/take-picture', async (req, res) => {
    await captureImage();
    res.send('Chụp ảnh thành công!');
});

// Route để nhận ảnh và gửi đến chương trình AI
app.post('/upload', upload.single('image'), (req, res) => {
    const imagePath = req.file.path;

    // Chạy chương trình AI với ảnh đã tải lên
    const pythonProcess = spawn('python', ['C:\\Users\\Meo\\Documents\\Learn_Python\\object-detect.py', imagePath]);

    pythonProcess.stdout.on('data', (data) => {
        console.log(`Kết quả nhận diện: ${data}`);
        res.send(data.toString()); // Gửi kết quả về cho client
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Lỗi: ${data}`);
        res.status(500).send('Đã xảy ra lỗi trong quá trình xử lý ảnh.');
    });

    // pythonProcess.on('close', (code) => {
    //     console.log(`Python process exited with code ${code}`);
    //     // Gửi phản hồi sau khi tiến trình Python hoàn tất
    //     res.send('Object detection completed');
    // });

    // // Đảm bảo không gửi phản hồi một lần nữa nếu có lỗi
    // pythonProcess.on('error', (error) => {
    //     console.error(`Error spawning Python process: ${error}`);
    //     if (!res.headersSent) { // Kiểm tra xem headers đã được gửi chưa
    //         res.status(500).send('Error occurred while processing image.');
    //     }
    // });
});

// Endpoint để nhận dữ liệu nhiệt độ từ ESP32
app.get('/temperature', (req, res) => {
    const temperature = parseFloat(req.query.temp);

    if (isNaN(temperature)) {
        return res.status(400).json({ message: 'Sai định dạng dữ liệu nhiệt độ' });
    }

    console.log(`Nhiệt độ nhận được từ ESP32: ${temperature}°C`);

    // Ngưỡng nhiệt độ để cảnh báo cháy
    const FIRE_ALERT_THRESHOLD = 45; // bạn có thể chỉnh sửa ngưỡng này

    if (temperature >= FIRE_ALERT_THRESHOLD) {
        console.warn(`CẢNH BÁO: Nhiệt độ quá cao (${temperature}°C). Khả năng có cháy!`);
        res.status(200).json({ message: 'Cảnh báo cháy!', alert: true });
    } else {
        res.status(200).json({ message: 'Nhiệt độ an toàn', alert: false });
    }
});

// Hàm gọi ESP32 để lấy dữ liệu nhiệt độ (giả sử ESP32 có một endpoint cung cấp dữ liệu nhiệt độ)
async function fetchTemperature() {
    try {
        const response = await axios.get(`http://${ESP32_IP}/temperature`);
        console.log('Dữ liệu nhiệt độ:', response.data);
        return response.data;
    } catch (error) {
        console.error('Có lỗi xảy ra khi lấy dữ liệu nhiệt độ từ ESP32:', error.message);
        return null;
    }
}
const axios = require('axios');

app.get('/open-gate', async (req, res) => {
    // Kiểm tra trạng thái nhiệt độ
    const temperature = parseFloat(req.query.temp);

    if (isNaN(temperature)) {
        return res.status(400).json({ message: 'Sai định dạng dữ liệu nhiệt độ' });
    }

    console.log(`Nhiệt độ nhận được từ ESP32: ${temperature}°C`);

    const FIRE_ALERT_THRESHOLD = 450; // Ngưỡng nhiệt độ để cảnh báo cháy

    if (temperature >= FIRE_ALERT_THRESHOLD) {
        console.warn("CẢNH BÁO CHÁY! Gửi tín hiệu mở cửa...");

        // Gửi tín hiệu mở cửa đến ESP32
        const esp32Url = 'http://192.168.0.117/open-gate'; // IP của ESP32
        try {
            const response = await axios.get(esp32Url); // Gửi HTTP GET yêu cầu mở cửa
            console.log("Phản hồi từ ESP32:", response.data);

            console.log("Cửa số 2 được mở tự động, cảnh báo cháy!");
            res.status(200).json({ message: "Cửa số 2 được mở tự động, cảnh báo cháy!" });
        } catch (error) {
            console.error("Lỗi khi gửi tín hiệu đến ESP32:", error.message);
            res.status(500).json({ message: "Không thể gửi tín hiệu mở cửa đến ESP32." });
        }
    } else {
        res.status(200).json({ message: "Nhiệt độ an toàn, không cần mở cửa." });
    }
});

// end of entrypoint

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});


