#ifndef PLATFORM_GRID_HPP
#define PLATFORM_GRID_HPP

// Broadphase for the static platforms of one level: a uniform grid built once in Simulation::loadLevel. A query
// returns the indices of every platform that could overlap a box, in ascending order. It is a filter only: callers
// still run the exact overlap test, so extra candidates cost a test and a missing one would be a bug.

#include <vector>

#include "../Types.hpp"

class PlatformGrid {
public:
    // Default cell edge in world units. The player is 0.5 x 0.8, so a query usually touches 1-4 cells.
    static constexpr float CELL_SIZE = 4.0f;

    // Replace the contents with `platforms` (indices are positions in this vector).
    void build(const std::vector<Platform>& platforms);

    // Fill `out` (cleared first) with the ascending, unique indices of the platforms whose box may overlap the box
    // centred at `center` with `size`. Every platform that boxesOverlap() would report is included.
    void query(const Vec2& center, const Vec2& size, std::vector<int>& out) const;

    float cellSize() const { return cellSize_; }
    int columns() const { return columns_; }
    int rows() const { return rows_; }

private:
    struct CellRange { int x0, y0, x1, y1; };
    bool cellRange(float minX, float minY, float maxX, float maxY, CellRange& out) const;

    float originX_ = 0.0f;
    float originY_ = 0.0f;
    float cellSize_ = CELL_SIZE;
    int columns_ = 0;
    int rows_ = 0;
    // Cell c holds cellItems_[cellStart_[c] .. cellStart_[c + 1]), ascending.
    std::vector<int> cellStart_;
    std::vector<int> cellItems_;
    // Tested by every query: non-finite boxes and very large ones (which would otherwise fill many cells).
    std::vector<int> always_;
};

#endif // PLATFORM_GRID_HPP
