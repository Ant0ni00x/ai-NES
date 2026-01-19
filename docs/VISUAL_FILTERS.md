# ai-NES Emulator Visual Filters Guide

This guide explains how to customize the visual appearance of the NES emulator by adjusting CSS filters, scanlines, and CRT effects.

## 📍 Filter Locations

All visual filters are defined in **`nes.css`**:

- **Line 152** - Canvas filter (contrast, brightness, saturation)
- **Lines 116-127** - Scanline effect (CRT horizontal lines)
- **Lines 129-140** - Vignette effect (screen edge darkening)

---

## 🎨 1. Canvas Filter (Primary Control)

**Location:** `nes.css` line 152

```css
canvas {
    filter: contrast(1.1) brightness(1.05);
}
```

### Available Filter Properties

| Property | Default | Description | Example Values |
|----------|---------|-------------|----------------|
| `contrast()` | 1.0 | Adjusts contrast | `0.8` (low), `1.0` (normal), `1.3` (high) |
| `brightness()` | 1.0 | Adjusts brightness | `0.9` (darker), `1.0` (normal), `1.2` (brighter) |
| `saturate()` | 1.0 | Color saturation | `0.5` (desaturated), `1.0` (normal), `1.5` (vivid) |
| `hue-rotate()` | 0deg | Shifts color hue | `5deg`, `15deg`, `45deg` |
| `blur()` | 0px | Blur amount (CRT effect) | `0.3px`, `0.5px`, `1px` |
| `grayscale()` | 0 | Grayscale conversion | `0` (color), `0.5` (partial), `1` (full grayscale) |
| `sepia()` | 0 | Sepia tone | `0` (none), `0.3` (subtle), `1` (full sepia) |

### Example Combinations

```css
/* Sharp and vibrant */
filter: contrast(1.2) brightness(1.1) saturate(1.3);

/* Soft CRT look */
filter: contrast(1.15) brightness(1.0) blur(0.5px);

/* Dark and moody */
filter: contrast(1.3) brightness(0.85) saturate(0.9);

/* Retro sepia */
filter: contrast(1.1) brightness(1.05) sepia(0.3);

/* Multiple effects */
filter: contrast(1.2) brightness(1.1) saturate(1.2) hue-rotate(5deg) blur(0.3px);
```

---

## 📺 2. Scanline Effect

**Location:** `nes.css` lines 116-127

```css
.crt-container::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background:
        repeating-linear-gradient(
            0deg,
            rgba(0,0,0,0.15) 0px,
            transparent 1px,
            transparent 2px,
            rgba(0,0,0,0.15) 3px
        );
    pointer-events: none;
    z-index: 2;
    border-radius: 8px;
}
```

### Scanline Intensity Options

| Intensity | Opacity Value | Description |
|-----------|---------------|-------------|
| **Off** | `rgba(0,0,0,0)` | No scanlines |
| **Very Light** | `rgba(0,0,0,0.05)` | Barely visible |
| **Light** | `rgba(0,0,0,0.1)` | Subtle effect |
| **Medium** | `rgba(0,0,0,0.15)` | Default - balanced |
| **Strong** | `rgba(0,0,0,0.25)` | Prominent scanlines |
| **Very Strong** | `rgba(0,0,0,0.4)` | Heavy CRT effect |

### Scanline Spacing Options

Change the pattern spacing for different effects:

```css
/* Fine scanlines (every 2px) */
repeating-linear-gradient(
    0deg,
    rgba(0,0,0,0.2) 0px,
    transparent 1px,
    rgba(0,0,0,0.2) 2px
);

/* Default scanlines (every 3px) */
repeating-linear-gradient(
    0deg,
    rgba(0,0,0,0.15) 0px,
    transparent 1px,
    transparent 2px,
    rgba(0,0,0,0.15) 3px
);

/* Wide scanlines (every 4px) */
repeating-linear-gradient(
    0deg,
    rgba(0,0,0,0.15) 0px,
    transparent 2px,
    rgba(0,0,0,0.15) 4px
);
```

### Remove Scanlines Completely

```css
.crt-container::before {
    display: none;
}
```

---

## 🌑 3. Vignette Effect (Edge Darkening)

**Location:** `nes.css` lines 129-140

```css
.crt-container::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.3) 100%);
    pointer-events: none;
    z-index: 3;
    border-radius: 8px;
}
```

### Vignette Intensity Options

| Intensity | Opacity Value | Description |
|-----------|---------------|-------------|
| **Off** | `rgba(0,0,0,0)` | No vignette |
| **Subtle** | `rgba(0,0,0,0.1)` | Barely noticeable |
| **Light** | `rgba(0,0,0,0.2)` | Gentle darkening |
| **Medium** | `rgba(0,0,0,0.3)` | Default - balanced |
| **Strong** | `rgba(0,0,0,0.5)` | Pronounced effect |
| **Very Strong** | `rgba(0,0,0,0.7)` | Heavy darkening |

### Remove Vignette Completely

```css
.crt-container::after {
    display: none;
}
```

---

## 🎯 Ready-to-Use Presets

### Preset 1: Clean & Sharp (No CRT)

**Best for:** Clear visibility, modern look

```css
/* Canvas filter */
canvas {
    filter: contrast(1.15) brightness(1.1) saturate(1.1);
}

/* Disable scanlines */
.crt-container::before {
    display: none;
}

/* Disable vignette */
.crt-container::after {
    display: none;
}
```

---

### Preset 2: Authentic CRT

**Best for:** Realistic retro experience

```css
/* Canvas filter */
canvas {
    filter: contrast(1.15) brightness(1.0) saturate(1.05) blur(0.5px);
}

/* Medium scanlines */
.crt-container::before {
    background: repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.2) 0px,
        transparent 1px,
        transparent 2px,
        rgba(0,0,0,0.2) 3px
    );
}

/* Medium vignette */
.crt-container::after {
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.35) 100%);
}
```

---

### Preset 3: Heavy CRT Effect

**Best for:** Maximum nostalgia

```css
/* Canvas filter */
canvas {
    filter: contrast(1.2) brightness(0.95) blur(0.7px);
}

/* Strong scanlines */
.crt-container::before {
    background: repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.3) 0px,
        transparent 1px,
        transparent 2px,
        rgba(0,0,0,0.3) 3px
    );
}

/* Strong vignette */
.crt-container::after {
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.5) 100%);
}
```

---

### Preset 4: Vibrant Colors

**Best for:** Colorful games like Mario, Kirby

```css
/* Canvas filter */
canvas {
    filter: contrast(1.3) brightness(1.15) saturate(1.4);
}

/* Light scanlines */
.crt-container::before {
    background: repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.08) 0px,
        transparent 1px,
        transparent 2px,
        rgba(0,0,0,0.08) 3px
    );
}

/* Light vignette */
.crt-container::after {
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.15) 100%);
}
```

---

### Preset 5: Soft & Dreamy

**Best for:** RPGs, atmospheric games

```css
/* Canvas filter */
canvas {
    filter: contrast(1.05) brightness(1.1) saturate(1.15) blur(0.4px);
}

/* Very light scanlines */
.crt-container::before {
    background: repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.05) 0px,
        transparent 1px,
        transparent 2px,
        rgba(0,0,0,0.05) 3px
    );
}

/* Light vignette */
.crt-container::after {
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.2) 100%);
}
```

---

### Preset 6: Arcade Monitor

**Best for:** Action games, arcade ports

```css
/* Canvas filter */
canvas {
    filter: contrast(1.25) brightness(1.05) saturate(1.2) blur(0.3px);
}

/* Fine scanlines */
.crt-container::before {
    background: repeating-linear-gradient(
        0deg,
        rgba(0,0,0,0.18) 0px,
        transparent 1px,
        rgba(0,0,0,0.18) 2px
    );
}

/* Medium-strong vignette */
.crt-container::after {
    background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.4) 100%);
}
```

---

## 🔧 How to Apply Changes

### Method 1: Edit CSS File (Permanent)

1. Open `nes.css`
2. Find the relevant section (lines 142-156 for canvas, 116-127 for scanlines, 129-140 for vignette)
3. Replace with your chosen preset or custom values
4. Rebuild the project: `./build.sh`
5. Refresh browser

### Method 2: Browser Console (Testing)

Test changes live without rebuilding:

```javascript
// Test canvas filter
document.querySelector('canvas').style.filter = 'contrast(1.3) brightness(1.15) saturate(1.2)';

// Test scanline intensity
document.querySelector('.crt-container').style.setProperty('--scanline-opacity', '0.3');

// Disable scanlines
document.querySelector('.crt-container::before').style.display = 'none';
```

---

## 💡 Tips & Best Practices

1. **Start conservative** - Small changes have big impact
2. **Brightness balance** - If you increase palette brightness (in `palette-table.js`), reduce canvas brightness
3. **Contrast vs Saturation** - High contrast often looks better with moderate saturation
4. **Blur for authenticity** - Real CRTs had slight blur; 0.3-0.5px is realistic
5. **Scanline visibility** - Works best at 2x-4x native resolution
6. **Test with different games** - Some games look better with different settings
7. **Match your display** - Bright monitors may need darker settings, dim displays need brighter

---

## 📊 Combined Recommendations

### For Bright Displays (LED/OLED)
```css
canvas {
    filter: contrast(1.1) brightness(0.95) saturate(1.1);
}
```

### For Dim/Standard Displays
```css
canvas {
    filter: contrast(1.2) brightness(1.15) saturate(1.15);
}
```

### For Small Screens (Mobile)
```css
canvas {
    filter: contrast(1.15) brightness(1.1) saturate(1.2);
}

/* Disable scanlines on small screens */
.crt-container::before {
    display: none;
}
```

---

## 🔗 Related Settings

- **Palette Brightness:** Edit `BRIGHTNESS_BOOST` in `src/palette-table.js` (currently 1.2)
- **Audio Levels:** Edit channel multipliers in `src/apu.js` lines 320-332
- **Canvas Size:** Edit in `nes.css` line 144-145

---

## 📝 Notes

- All filter values are multiplicative (1.0 = no change, >1.0 increases, <1.0 decreases)
- CSS filters are GPU-accelerated for good performance
- Scanlines use pseudo-elements (::before/::after) for layering
- Changes to CSS require rebuild (`./build.sh`) to update production bundle
- For quick testing, use browser developer tools to modify live

---

**Last Updated:** January 2026
**Emulator Version:** ai-NES v1.0
**Palette Brightness:** 1.2x (20% boost)
**Default Canvas Filter:** `contrast(1.1) brightness(1.05)`
