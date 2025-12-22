// Native Draw Test Plugin
// Tests the native debug line drawing system

const poe2 = new POE2();

let showWindowMutable = new imgui.MutableVariable(true);
let testLines = [];
let drawTestLinesMutable = new imgui.MutableVariable(false);

// Generate some test lines around the player
function generateTestLines() {
    const player = poe2.getLocalPlayer();
    if (!player || !player.worldX) {
        // Generate test lines even without player - use fixed coords
        console.log("[NativeDrawTest] No player, using fixed coordinates");
        return [
            { x1: 0, y1: 0, z1: 0, x2: 1000, y2: 0, z2: 0, r: 1, g: 0, b: 0, a: 1 },
            { x1: 0, y1: 0, z1: 0, x2: 0, y2: 1000, z2: 0, r: 0, g: 1, b: 0, a: 1 },
            { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 1000, r: 0, g: 0, b: 1, a: 1 },
        ];
    }
    
    const lines = [];
    const centerX = player.worldX;
    const centerY = player.worldY;
    const centerZ = player.worldZ || 0;  // Use player's Z coordinate!
    
    // Try multiple Z heights to see which one is visible
    const zValues = [centerZ, centerZ + 50, centerZ - 50, centerZ + 100, 0];
    
    // Use a smaller radius for testing - maybe 500 is too big
    const radius = 200;
    
    console.log("[NativeDrawTest] Player at: (" + centerX.toFixed(1) + ", " + centerY.toFixed(1) + ", " + centerZ.toFixed(1) + ")");
    
    // Create a simple square around the player (easier to see than circle)
    // Try at player's Z
    lines.push({
        x1: centerX - radius, y1: centerY - radius, z1: centerZ,
        x2: centerX + radius, y2: centerY - radius, z2: centerZ,
        r: 1, g: 0, b: 0, a: 1  // Red - bottom
    });
    lines.push({
        x1: centerX + radius, y1: centerY - radius, z1: centerZ,
        x2: centerX + radius, y2: centerY + radius, z2: centerZ,
        r: 0, g: 1, b: 0, a: 1  // Green - right
    });
    lines.push({
        x1: centerX + radius, y1: centerY + radius, z1: centerZ,
        x2: centerX - radius, y2: centerY + radius, z2: centerZ,
        r: 0, g: 0, b: 1, a: 1  // Blue - top
    });
    lines.push({
        x1: centerX - radius, y1: centerY + radius, z1: centerZ,
        x2: centerX - radius, y2: centerY - radius, z2: centerZ,
        r: 1, g: 1, b: 0, a: 1  // Yellow - left
    });
    
    // Try a vertical line (Z axis) to see if 3D works
    lines.push({
        x1: centerX, y1: centerY, z1: centerZ - 100,
        x2: centerX, y2: centerY, z2: centerZ + 200,
        r: 1, g: 0, b: 1, a: 1  // Magenta - vertical
    });
    
    // Cross at Z=0 for comparison
    lines.push({
        x1: centerX - radius, y1: centerY, z1: 0,
        x2: centerX + radius, y2: centerY, z2: 0,
        r: 0.5, g: 0.5, b: 0.5, a: 1  // Gray at Z=0
    });
    
    return lines;
}

function onDraw() {
    // Draw ImGui window
    if (showWindowMutable.value) {
        const flags = imgui.WindowFlags.AlwaysAutoResize;
        const shouldDraw = imgui.begin("Native Draw Test", showWindowMutable, flags);
        
        if (shouldDraw) {
            const available = poe2.isNativeDrawAvailable();
            
            imgui.text("Native Draw System: " + (available ? "AVAILABLE" : "NOT AVAILABLE"));
            imgui.separator();
            
            if (available) {
                imgui.checkbox("Draw Test Lines", drawTestLinesMutable);
                
                if (drawTestLinesMutable.value) {
                    testLines = generateTestLines();
                    imgui.text("Drawing " + testLines.length + " lines");
                }
                
            imgui.separator();
            imgui.textColored([0.5, 0.5, 0.5, 1], "Lines are drawn in world space around player");
            imgui.textColored([0.5, 0.5, 0.5, 1], "Green circle + Red/Blue cross");
        } else {
            imgui.textColored([1, 0.5, 0, 1], "Native draw system failed to initialize.");
            imgui.textColored([1, 0.5, 0, 1], "Check console for errors.");
            imgui.textColored([0.5, 0.5, 0.5, 1], "Offsets may need updating for game version.");
            }
        }
        
        imgui.end();
    }
    
    // Draw native lines if enabled
    if (drawTestLinesMutable.value && poe2.isNativeDrawAvailable()) {
        for (const line of testLines) {
            poe2.drawNativeLine(
                line.x1, line.y1, line.z1,
                line.x2, line.y2, line.z2,
                line.r, line.g, line.b, line.a
            );
        }
    }
}

// Export plugin
export const nativeDrawTestPlugin = {
    onDraw: onDraw
};

try {
    console.log("[NativeDrawTest] Plugin loaded. Native draw available:", poe2.isNativeDrawAvailable());
} catch (e) {
    console.log("[NativeDrawTest] Plugin loaded (poe2 not yet available)");
}
