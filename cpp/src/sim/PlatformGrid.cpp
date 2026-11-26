#include "PlatformGrid.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace {

// Queries grow the box by this much on every side, so float rounding in the cell maths can never drop a platform
// that the exact test (overlap > CONTACT_EPSILON) would report. Extra candidates are only a wasted test.
constexpr float QUERY_MARGIN = 1.0f / 16.0f;

// Cap on the grid size: past it the cell edge doubles until the level's platform bounds fit.
constexpr double MAX_CELLS = 65536.0;

// A platform covering more cells than this goes on the always-tested list instead of into every cell.
constexpr int MAX_CELLS_PER_PLATFORM = 128;

struct Extent { float minX, minY, maxX, maxY; };

bool isFinite(const Extent& e) {
    return std::isfinite(e.minX) && std::isfinite(e.minY) && std::isfinite(e.maxX) && std::isfinite(e.maxY);
}

// The box a platform can collide within. boxesOverlap() sums signed sizes, so |size| / 2 always covers it.
Extent extentOf(const Platform& platform) {
    const float hx = std::abs(platform.size.x) * 0.5f;
    const float hy = std::abs(platform.size.y) * 0.5f;
    return {platform.position.x - hx, platform.position.y - hy, platform.position.x + hx, platform.position.y + hy};
}

} // namespace

void PlatformGrid::build(const std::vector<Platform>& platforms) {
    originX_ = originY_ = 0.0f;
    cellSize_ = CELL_SIZE;
    columns_ = rows_ = 0;
    cellStart_.clear();
    cellItems_.clear();
    always_.clear();

    std::vector<Extent> extents;
    extents.reserve(platforms.size());
    bool any = false;
    Extent bounds{0.0f, 0.0f, 0.0f, 0.0f};
    for (const Platform& platform : platforms) {
        const Extent e = extentOf(platform);
        extents.push_back(e);
        if (!isFinite(e)) continue;
        if (!any) {
            bounds = e;
            any = true;
        } else {
            bounds.minX = std::min(bounds.minX, e.minX);
            bounds.minY = std::min(bounds.minY, e.minY);
            bounds.maxX = std::max(bounds.maxX, e.maxX);
            bounds.maxY = std::max(bounds.maxY, e.maxY);
        }
    }

    // A span that overflows float (platforms near +-FLT_MAX) leaves the grid empty: everything is always tested.
    if (any && std::isfinite(bounds.maxX - bounds.minX) && std::isfinite(bounds.maxY - bounds.minY)) {
        originX_ = bounds.minX;
        originY_ = bounds.minY;
        // Size check in double: a huge level would overflow an int before the cap is applied.
        const auto cellsFor = [&](float cell) {
            const double columns = std::floor((static_cast<double>(bounds.maxX) - originX_) / cell) + 1.0;
            const double rows = std::floor((static_cast<double>(bounds.maxY) - originY_) / cell) + 1.0;
            return columns * rows;
        };
        while (cellsFor(cellSize_) > MAX_CELLS) cellSize_ *= 2.0f;
        // Same float formula as cellRange(), so every platform's cells fall inside the grid.
        columns_ = static_cast<int>(std::floor((bounds.maxX - originX_) / cellSize_)) + 1;
        rows_ = static_cast<int>(std::floor((bounds.maxY - originY_) / cellSize_)) + 1;
    }

    // Counting sort into per-cell lists. Platforms go in by ascending index, so every cell list is ascending.
    const std::size_t cellCount = static_cast<std::size_t>(columns_) * static_cast<std::size_t>(rows_);
    std::vector<CellRange> ranges(platforms.size());
    std::vector<bool> inGrid(platforms.size(), false);
    cellStart_.assign(cellCount + 1, 0);
    for (std::size_t i = 0; i < platforms.size(); ++i) {
        const Extent& e = extents[i];
        CellRange& r = ranges[i];
        const bool placed = isFinite(e) && cellRange(e.minX, e.minY, e.maxX, e.maxY, r) &&
            (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= MAX_CELLS_PER_PLATFORM;
        if (!placed) {
            always_.push_back(static_cast<int>(i));
            continue;
        }
        inGrid[i] = true;
        for (int y = r.y0; y <= r.y1; ++y) {
            for (int x = r.x0; x <= r.x1; ++x) ++cellStart_[static_cast<std::size_t>(y) * columns_ + x + 1];
        }
    }
    for (std::size_t c = 0; c < cellCount; ++c) cellStart_[c + 1] += cellStart_[c];
    cellItems_.assign(static_cast<std::size_t>(cellStart_[cellCount]), 0);
    std::vector<int> fill(cellStart_.begin(), cellStart_.end() - 1);
    for (std::size_t i = 0; i < platforms.size(); ++i) {
        if (!inGrid[i]) continue;
        const CellRange& r = ranges[i];
        for (int y = r.y0; y <= r.y1; ++y) {
            for (int x = r.x0; x <= r.x1; ++x) {
                cellItems_[static_cast<std::size_t>(fill[static_cast<std::size_t>(y) * columns_ + x]++)] = static_cast<int>(i);
            }
        }
    }
}

void PlatformGrid::query(const Vec2& center, const Vec2& size, std::vector<int>& out) const {
    out.assign(always_.begin(), always_.end());
    const float hx = std::abs(size.x) * 0.5f + QUERY_MARGIN;
    const float hy = std::abs(size.y) * 0.5f + QUERY_MARGIN;
    CellRange r{};
    // A non-finite box overlaps nothing in boxesOverlap(); cellRange() rejects it too.
    if (!cellRange(center.x - hx, center.y - hy, center.x + hx, center.y + hy, r)) return;
    for (int y = r.y0; y <= r.y1; ++y) {
        for (int x = r.x0; x <= r.x1; ++x) {
            const std::size_t c = static_cast<std::size_t>(y) * columns_ + x;
            out.insert(out.end(), cellItems_.begin() + cellStart_[c], cellItems_.begin() + cellStart_[c + 1]);
        }
    }
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
}

// The cells a box touches, clamped to the grid. False if it misses the grid entirely (or is NaN).
bool PlatformGrid::cellRange(float minX, float minY, float maxX, float maxY, CellRange& out) const {
    if (columns_ <= 0 || rows_ <= 0) return false;
    const float x0 = std::floor((minX - originX_) / cellSize_);
    const float x1 = std::floor((maxX - originX_) / cellSize_);
    const float y0 = std::floor((minY - originY_) / cellSize_);
    const float y1 = std::floor((maxY - originY_) / cellSize_);
    const float lastX = static_cast<float>(columns_ - 1);
    const float lastY = static_cast<float>(rows_ - 1);
    if (!(x1 >= 0.0f && x0 <= lastX && y1 >= 0.0f && y0 <= lastY)) return false;
    out.x0 = static_cast<int>(std::max(x0, 0.0f));
    out.x1 = static_cast<int>(std::min(x1, lastX));
    out.y0 = static_cast<int>(std::max(y0, 0.0f));
    out.y1 = static_cast<int>(std::min(y1, lastY));
    return true;
}
