# Start Conservative with UI Magnification Effects

**Date**: 2026-01-26
**Context**: Oracle 3D Graph dock-style magnification implementation
**Confidence**: High

## Key Learning

When implementing UI magnification or scaling effects (like dock-style hover magnification), start with conservative values and scale up based on user feedback, rather than starting with dramatic values and scaling down.

In this session, I implemented dock-style node magnification where nodes grow when the mouse is near them. My initial values were:
- `maxMagnify = 2.5` (nodes grow to 250% of original size)
- `magnifyRadius = 0.5` (50% of normalized screen space)

The user's immediate feedback was "when hover it big alot!" - the effect was overwhelming rather than delightful. We ended up reducing to:
- `maxMagnify = 1.8` (180% - still noticeable but not overwhelming)
- `magnifyRadius = 0.4` (tighter proximity for more controlled effect)

## The Pattern

```javascript
// ❌ WRONG: Start dramatic, scale down
const maxMagnify = 2.5;  // Too aggressive
const magnifyRadius = 0.5;

// ✅ RIGHT: Start conservative, scale up if needed
const maxMagnify = 1.5;  // Subtle start
const magnifyRadius = 0.3;  // Tight proximity
// User says "can it be bigger?" → increase
```

## Why This Matters

1. **First impressions matter**: An overwhelming initial effect can make users dismiss the feature entirely
2. **Scaling up feels like adding value**: "Can we make it bigger?" feels like enhancement, while "too big!" feels like fixing a bug
3. **Perception varies by device**: What looks good on a large monitor may be overwhelming on a laptop
4. **Context affects perception**: In a busy visualization with many nodes, even small magnification can feel large

## Related: Always Consider Aspect Ratio

When doing screen-space calculations for proximity effects, always account for viewport aspect ratio:

```javascript
// ❌ WRONG: Treats screen as square
const screenDist = Math.sqrt(
  Math.pow(tempVec.x - mouse.x, 2) +
  Math.pow(tempVec.y - mouse.y, 2)
);

// ✅ RIGHT: Account for aspect ratio
const aspectRatio = width / height;
const screenDist = Math.sqrt(
  Math.pow((tempVec.x - mouse.x) * aspectRatio, 2) +
  Math.pow(tempVec.y - mouse.y, 2)
);
```

Without aspect ratio correction, the "radius" becomes an ellipse in screen space, making effects feel unbalanced on wide screens.

## Tags

`ui`, `animation`, `magnification`, `user-feedback`, `three.js`, `aspect-ratio`
