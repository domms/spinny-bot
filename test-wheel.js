const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// Colors for the wheel (same as bot.js)
const WHEEL_COLORS = [
    [255, 100, 100],  // Red
    [100, 255, 100],  // Green
    [100, 100, 255],  // Blue
    [255, 255, 100],  // Yellow
    [255, 100, 255],  // Magenta
    [100, 255, 255],  // Cyan
    [255, 200, 100],  // Orange
    [200, 100, 255],  // Purple
];

/**
 * Create a visual representation of the wheel with names
 */
function createWheelImage(names, winnerIndex = null, size = 800) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size / 2 - 20;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);

    if (!names || names.length === 0) {
        ctx.fillStyle = 'black';
        ctx.font = '30px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No names', centerX, centerY);
        return canvas;
    }

    const numSegments = names.length;
    const anglePerSegment = (2 * Math.PI) / numSegments;

    for (let i = 0; i < names.length; i++) {
        const startAngle = i * anglePerSegment - Math.PI / 2;
        const endAngle = (i + 1) * anglePerSegment - Math.PI / 2;

        let color = WHEEL_COLORS[i % WHEEL_COLORS.length];
        if (winnerIndex !== null && i === winnerIndex) {
            color = color.map(c => Math.min(255, c + 50));
        }

        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();

        const midAngle = (startAngle + endAngle) / 2;
        const textRadius = radius * 0.7;
        const textX = centerX + textRadius * Math.cos(midAngle);
        const textY = centerY + textRadius * Math.sin(midAngle);

        const displayName = names[i].length > 15 ? names[i].substring(0, 15) + '...' : names[i];

        ctx.save();
        ctx.translate(textX, textY);
        ctx.rotate(midAngle + Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'black';
        ctx.font = 'bold 20px Arial';
        ctx.fillText(displayName, 0, 0);
        ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(centerX, centerY, 30, 0, 2 * Math.PI);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(centerX, 20);
    ctx.lineTo(centerX - 30, 50);
    ctx.lineTo(centerX + 30, 50);
    ctx.closePath();
    ctx.fillStyle = 'red';
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.stroke();

    return canvas;
}

/**
 * Simulate the wheel spinning process
 */
function spinWheel(names) {
    if (!names || names.length === 0) {
        return null;
    }
    return Math.floor(Math.random() * names.length);
}

// Test data
const testNamesOnWheel = [
    "Alice",
    "Bob",
    "Charlie",
    "Diana",
    "Eve",
    "Frank",
    "Grace",
    "Henry"
];

const testNamesOffWheel = [
    "Iris",
    "Jack",
    "Kate",
    "Liam",
    "Mia",
    "Noah",
    "Olivia",
    "Paul"
];

// Create output directory
const outputDir = path.join(__dirname, 'test_output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

console.log('🎡 Testing wheel spinner with fake data...\n');

// Test 1: Wheel with "On the wheel" users
console.log('Test 1: Creating wheel with "On the wheel" users...');
const onWheelCanvas = createWheelImage(testNamesOnWheel);
const onWheelBuffer = onWheelCanvas.toBuffer('image/png');
fs.writeFileSync(path.join(outputDir, 'on_wheel.png'), onWheelBuffer);
console.log('✅ Saved: test_output/on_wheel.png\n');

// Test 2: Wheel with winner highlighted
console.log('Test 2: Creating wheel with winner highlighted...');
const winnerIndex = spinWheel(testNamesOnWheel);
console.log(`Winner: ${testNamesOnWheel[winnerIndex]}`);
const winnerCanvas = createWheelImage(testNamesOnWheel, winnerIndex);
const winnerBuffer = winnerCanvas.toBuffer('image/png');
fs.writeFileSync(path.join(outputDir, 'wheel_with_winner.png'), winnerBuffer);
console.log('✅ Saved: test_output/wheel_with_winner.png\n');

// Test 3: Simulate the full spinning process
console.log('Test 3: Simulating full spinning process...');
let remainingNames = [...testNamesOnWheel];
let round = 1;

while (remainingNames.length > 1) {
    const winnerIdx = spinWheel(remainingNames);
    const winner = remainingNames[winnerIdx];
    
    console.log(`Round ${round}: ${winner} is removed`);
    
    // Save wheel image for this round
    const roundCanvas = createWheelImage(remainingNames, winnerIdx);
    const roundBuffer = roundCanvas.toBuffer('image/png');
    fs.writeFileSync(path.join(outputDir, `round_${round}.png`), roundBuffer);
    
    // Remove winner
    remainingNames.splice(winnerIdx, 1);
    round++;
}

console.log(`\n🏆 Final Winner: ${remainingNames[0]}`);
const finalCanvas = createWheelImage([remainingNames[0]], 0);
const finalBuffer = finalCanvas.toBuffer('image/png');
fs.writeFileSync(path.join(outputDir, 'final_winner.png'), finalBuffer);
console.log('✅ Saved: test_output/final_winner.png\n');

// Test 4: "Off the wheel" users (if 6+)
if (testNamesOffWheel.length >= 6) {
    console.log('Test 4: Creating wheel for "Off the wheel" users (6+ required)...');
    const offWheelWinnerIdx = spinWheel(testNamesOffWheel);
    console.log(`Winner to bring back: ${testNamesOffWheel[offWheelWinnerIdx]}`);
    const offWheelCanvas = createWheelImage(testNamesOffWheel, offWheelWinnerIdx);
    const offWheelBuffer = offWheelCanvas.toBuffer('image/png');
    fs.writeFileSync(path.join(outputDir, 'off_wheel_spin.png'), offWheelBuffer);
    console.log('✅ Saved: test_output/off_wheel_spin.png\n');
}

// Test 5: Small wheel (2-3 people)
console.log('Test 5: Testing with small group (3 people)...');
const smallGroup = ["Alice", "Bob", "Charlie"];
const smallCanvas = createWheelImage(smallGroup);
const smallBuffer = smallCanvas.toBuffer('image/png');
fs.writeFileSync(path.join(outputDir, 'small_wheel.png'), smallBuffer);
console.log('✅ Saved: test_output/small_wheel.png\n');

console.log('✨ All tests complete! Check the test_output/ folder for generated images.');




