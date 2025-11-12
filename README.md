# 🗺️ City Polygon Viewer with Advanced Yelp Integration

A sophisticated geospatial web application that combines city boundary visualization with intelligent business discovery using H3 hexagon grids and the Yelp API. This application demonstrates advanced geospatial processing, API management, and data visualization techniques.

## 🌟 Overview

This application transforms city boundary data into a powerful business discovery tool by:
- Fetching precise city boundaries from OpenStreetMap using multiple query strategies
- Generating H3 hexagon grids (Resolution 7) for systematic area coverage
- Performing intelligent business searches using the Yelp Fusion API
- Automatically subdividing dense areas (>240 businesses) into Resolution 8 hexagons
- Providing interactive visualization with map layers and business data

## 🏗️ Architecture

### **Frontend Stack**
- **Next.js 15** with App Router
- **TypeScript** for type safety
- **Tailwind CSS** for styling
- **Leaflet** for interactive mapping
- **React Hook Form** for form handling

### **Backend Services**
- **OpenStreetMap Overpass API** for city boundary data
- **Nominatim API** as fallback for boundary fetching
- **Yelp Fusion API** for business search
- **H3-JS** for hexagon grid generation
- **Turf.js** for geospatial calculations

### **Core Libraries**
- **@turf/turf**: Geospatial analysis and polygon operations
- **h3-js**: H3 hexagon grid system
- **leaflet.markercluster**: Marker clustering

## 🎯 How It Works - Complete Process Flow

### **Step 1: City Boundary Acquisition**

**User Input:**
- Format: `"City, State"` (e.g., `"Miami, FL"`)
- Sent via GET request to `/api/city?name={cityName}`

**Process:**
1. **Overpass API Strategy 1** (Standard City Boundaries)
   - Query: Searches for `relation` elements with:
     - `boundary=administrative` AND `admin_level` 7 or 8
     - `place=city` with matching name
     - Bounded by state bounding box
   - Payload: Overpass QL query string
   - Returns: `{ elements: Array<OverpassElement> }`
   - Fallback: If no results, proceed to Strategy 2

2. **Overpass API Strategy 2** (Comprehensive Search)
   - Query: Broader search including:
     - Any `boundary` relation
     - `place` values: city, town, municipality
     - `way` and `node` elements with boundary/place tags
   - Payload: Overpass QL query string
   - Returns: `{ elements: Array<OverpassElement> }`
   - Fallback: If no results, proceed to Strategy 3

3. **Overpass API Strategy 3** (Aggressive Search)
   - Query: Most permissive search:
     - Any relation/way/node with matching name
     - Includes `landuse` tags (residential, municipal)
   - Payload: Overpass QL query string
   - Returns: `{ elements: Array<OverpassElement> }`
   - Fallback: If no results, proceed to Nominatim

4. **Boundary Selection**
   - Algorithm prioritizes by:
     1. `admin_level=8` + `place=city` (highest priority)
     2. `admin_level=7` + `place=city`
     3. `admin_level=8` (any)
     4. `admin_level=7` (any)
     5. `place=city` (any)
     6. `place=town`
     7. `boundary=administrative` (any)
     8. Any valid element with geometry
   - Converts selected element to GeoJSON using `osmRelationToGeoJSON()`
   - Calculates bounding box: `[minLon, minLat, maxLon, maxLat]`

5. **Nominatim Fallback** (if all Overpass strategies fail)
   - Request: `GET https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&q={cityName}`
   - Headers: `User-Agent` required
   - Returns: `Array<NominatimResult>` with `geojson` property
   - Selection: Prefers `class=boundary` + `type=administrative`, otherwise first result with polygon

**Response Payload:**
```typescript
{
  name: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  geojson: Feature<Polygon | MultiPolygon>;
  osm_id: number;
  source: 'overpass' | 'nominatim';
}
```

### **Step 2: Enhanced City Response Creation**

**Process:**
1. **Buffered Polygon Creation**
   - Input: Original GeoJSON polygon
   - Buffer: 1km (1000 meters) using `turf.buffer()`
   - Purpose: Ensures edge-case businesses aren't missed
   - Returns: Buffered `Feature<Polygon | MultiPolygon>`
   - Fallback: If buffering fails, returns original polygon

2. **H3 Grid Generation**
   - Input: Buffered polygon
   - Resolution: 7 (base resolution, ~4.8 km² per hexagon)
   - Method: `h3.polygonToCells()` - generates hexagons exactly clipped to polygon boundary
   - Returns: `Array<string>` of H3 cell IDs
   - Fallback: If `polygonToCells` fails, falls back to center-based generation with `gridDisk()`

3. **Grid Statistics Calculation**
   - Calculates:
     - `total_hexagons`: Count of H3 cells
     - `resolution`: 7
     - `avg_hexagon_size_km`: ~4.8 km² (from `h3.hexArea()`)
     - `coverage_area_km2`: `total_hexagons * avg_hexagon_size_km`

**Enhanced Response Payload:**
```typescript
{
  ...baseResponse,
  buffered_polygon: Feature<Polygon | MultiPolygon>;
  h3_grid: string[]; // Array of H3 cell IDs
  grid_stats: {
    total_hexagons: number;
    resolution: number; // 7
    avg_hexagon_size_km: number; // ~4.8
    coverage_area_km2: number;
  };
}
```

### **Step 3: Yelp Business Discovery (Two-Phase Processing)**

**User Action:**
- Clicks "Process Hexagons" button in Yelp Integration component
- Payload sent to `/api/yelp` POST endpoint:
```typescript
{
  action: 'process_hexagons';
  hexagons: Array<{ h3Id: string; mapIndex: number; originalIndex: number }>;
  testMode: boolean; // Limits to 10 hexagons if true
}
```

**Phase 1: Process Resolution 7 Hexagons**

For each hexagon:

1. **Quota Check**
   - Checks `yelpQuotaManager.estimateQuotaForCity()`
   - Estimates: `hexagonCount * 7 search points * 1.5 pages`
   - Validates against daily limit (5,000 calls) and per-second limit (50 calls)
   - Fallback: Returns error if insufficient quota (unless test mode)

2. **Search Point Generation** (`generateSearchPoints()`)
   - Calculates hexagon center: `h3.cellToLatLng(h3Id)`
   - Gets hexagon boundary: `h3.cellToBoundary(h3Id, true)`
   - Calculates optimal radius: Distance from center to furthest corner (capped at H3 resolution 7 inradius ~1.06km)
   - Adaptive coverage based on hexagon area:
     - **<3 km²**: 1 search point (center only)
     - **3-8 km²**: 3 search points (center + 2 corners)
     - **>8 km²**: 5+ search points (center + 3 corners + 2 edge midpoints)
   - Returns: `HexagonCoverage` with search points array

3. **Yelp API Search** (for each search point)
   - Rate Limiting: `yelpRateLimiter.waitForSlot()` - ensures ≤50 req/sec
   - Quota Tracking: `yelpQuotaManager.trackAPICall()`
   - Request: `GET https://api.yelp.com/v3/businesses/search`
     - Query params:
       - `latitude`: Search point lat
       - `longitude`: Search point lng
       - `radius`: Calculated radius in meters
       - `categories`: `'restaurants'`
       - `limit`: `50` (max per page)
       - `offset`: `0, 50, 100, 150` (for pagination)
   - Headers: `Authorization: Bearer {YELP_API_KEY}`
   - Pagination: Fetches up to 200 results (4 pages max) per search point
   - Response: `{ total: number; businesses: Array<YelpBusiness>; region: object }`

4. **Business Deduplication**
   - Combines businesses from all search points
   - Removes duplicates by business `id`
   - Returns: `Array<YelpBusiness>` (unique)

5. **Boundary Validation**
   - Filters businesses to ensure they're within hexagon boundaries
   - Method: `h3.latLngToCell(business.coords, resolution)` must match hexagon H3 ID
   - Returns: Validated businesses array
   - Fallback: If validation fails for a business, includes it anyway (fail-safe)

6. **Density Detection**
   - Checks if `totalBusinesses > 240`
   - If dense:
     - Calls `splitHexagon(h3Id, 7, 8)` - splits into ~7 child hexagons
     - Queues child hexagons in `hexagonProcessor.subdivisionQueue`
     - Returns status: `'split'`
   - If not dense:
     - Returns status: `'fetched'`

**Phase 1 Result:**
```typescript
{
  h3Id: string;
  mapIndex?: number;
  totalBusinesses: number;
  uniqueBusinesses: YelpBusiness[];
  searchResults: YelpSearchResult[];
  status: 'fetched' | 'split' | 'failed';
  coverageQuality: 'excellent' | 'good' | 'fair' | 'poor';
  error?: string;
}
```

**Phase 2: Process Subdivision Queue (Resolution 8 Hexagons)**

1. **Subdivision Queue Processing**
   - Processes all hexagons queued from Phase 1 splits
   - Each child hexagon processed at Resolution 8 (~0.7 km² per hexagon)
   - Same search process as Phase 1, but with:
     - Higher resolution (8 instead of 7)
     - Smaller hexagon area
     - Typically 1-3 search points per hexagon

2. **Parent-Child Relationship Tracking**
   - Maintains two maps:
     - `parentChildRelationships: Map<string, string[]>` - maps parent H3 ID → array of child H3 IDs
     - `childParentRelationships: Map<string, string>` - maps child H3 ID → parent H3 ID
   - Relationships are established when `handleDenseHexagons()` is called during Phase 1
   - Used for result aggregation and merging

3. **Result Deduplication Strategy**

   **Important Note on Business Deduplication:**
   
   When a parent hexagon is split:
   - **Phase 1**: Parent hexagon returns its businesses with status `'split'`
   - **Phase 2**: Child hexagons are processed and return their businesses
   - **Raw Results Array**: Contains BOTH parent and child result objects (line 209: `results = [...phase1Results, ...phase2Results]`)
   
   **Deduplication Levels:**
   
   1. **Within Search Points**: Businesses are deduplicated by `id` within each hexagon's search results (handled in `deduplicateBusinesses()`)
   
   2. **Within Child Hexagons**: When merging child results, `mergeSubHexagonResults()` deduplicates businesses across children by `id`
   
   3. **Count Replacement**: In `getMergedResults()`, when all children are processed:
      - Parent's `totalBusinesses` count is REPLACED with aggregated child total
      - This prevents double-counting in statistics
      - However, parent's `uniqueBusinesses` array remains in the raw `results` array
   
   4. **UI-Level Deduplication**: Final deduplication happens in `HexagonDisplay.getAllRestaurants()`:
      - Flattens all businesses from all result objects
      - Deduplicates by business `id` using a `Map<string, YelpBusiness>`
      - This ensures no duplicate businesses appear in the UI
   
   **Current Behavior:**
   - ✅ Parent-child relationships are tracked
   - ✅ Business counts are deduplicated (parent count replaced with child aggregate)
   - ⚠️ Business arrays contain duplicates: Parent businesses appear in parent result object AND may appear again in child result objects
   - ✅ UI layer handles final deduplication for display
   
   **Example:**
   ```
   Parent Hexagon (R7): Finds 300 businesses → Status: 'split'
   ├─ Child 1 (R8): Finds 50 businesses
   ├─ Child 2 (R8): Finds 45 businesses (5 overlap with Child 1)
   └─ Child 3 (R8): Finds 40 businesses (10 overlap with Child 1)
   
   Raw Results Array:
   - Parent result: { h3Id: 'parent', uniqueBusinesses: [300 businesses], status: 'split' }
   - Child 1 result: { h3Id: 'child1', uniqueBusinesses: [50 businesses] }
   - Child 2 result: { h3Id: 'child2', uniqueBusinesses: [45 businesses] }
   - Child 3 result: { h3Id: 'child3', uniqueBusinesses: [40 businesses] }
   
   Merged Results:
   - Parent: { totalBusinesses: 135, isParent: true, hasChildren: true }
     (Count replaced with child aggregate, but parent's 300 businesses still in raw array)
   
   UI Display:
   - getAllRestaurants() deduplicates all businesses by ID → ~135 unique businesses shown
   ```

**Final Response Payload:**
```typescript
{
  success: true;
  results: HexagonYelpResult[]; // Phase 1 + Phase 2 results
  processingStats: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    split: number;
    resolution7: number;
    resolution8: number;
    subdivisionQueue: number;
  };
  quotaStatus: {
    dailyUsed: number;
    dailyRemaining: number;
    perSecondUsed: number;
    perSecondRemaining: number;
  };
  subdivisionQueueStatus: {
    queuedCount: number;
    completedCount: number;
    failedCount: number;
  };
  resultsByResolution: {
    resolution7: HexagonProcessingStatus[];
    resolution8: HexagonProcessingStatus[];
  };
  mergedResults: Array<{
    h3Id: string;
    resolution: number;
    status: string;
    totalBusinesses: number;
    isParent: boolean;
    hasChildren: boolean;
    childrenSummary?: object;
  }>;
  testMode: boolean;
  processedAt: string;
}
```

### **Step 4: Data Visualization**

**Map Layers:**
1. **City Boundary** (blue): Original city limits from GeoJSON
2. **Buffered Area** (purple): 1km buffer zone
3. **H3 Grid** (green): Hexagon boundaries rendered from H3 cell IDs
4. **Hexagon Numbers** (orange): Labels showing hexagon index for correlation
5. **Restaurant Markers**: Clustered markers from Yelp results

**Display Components:**
- **HexagonDisplay**: Shows hexagon cards with business counts and status
- **YelpIntegration**: Controls for processing hexagons and viewing results
- **MapControls**: Toggle visibility of map layers

## 🔧 Key Technical Details

### **Rate Limiting**
- **Per-Second Limit**: 50 requests/second
- **Daily Limit**: 5,000 requests/day
- **Implementation**: `RateLimiter` class with queue management
- **Fallback**: Exponential backoff on rate limit errors

### **Quota Management**
- **Tracking**: Real-time daily and per-second usage
- **Estimation**: `estimateQuotaForCity()` calculates needed calls
- **Risk Levels**: low, medium, high, critical
- **Fallback**: Blocks processing if quota insufficient (unless test mode)

### **Search Point Optimization**
- **Radius Calculation**: Based on H3 hexagon inradius (~1.06km for resolution 7)
- **Adaptive Coverage**: More points for larger hexagons
- **No Hard Caps**: Removed arbitrary 3km radius limits, uses H3-based calculations

### **Business Validation**
- **Method**: H3 `latLngToCell()` to verify business is within hexagon
- **Fallback**: Includes business if validation fails (fail-safe approach)

### **Parent-Child Deduplication**
- **Relationship Tracking**: Both `parentChildRelationships` and `childParentRelationships` maps are maintained
- **Count Deduplication**: Parent business counts are replaced with child aggregates in `getMergedResults()`
- **Array Deduplication**: Business arrays may contain duplicates between parent and child results
- **UI Deduplication**: Final deduplication by business `id` happens in `HexagonDisplay.getAllRestaurants()`
- **Note**: The raw API response includes both parent and child result objects; deduplication is handled at the UI layer

### **Error Handling & Fallbacks**

1. **Overpass API Failures**
   - Retry logic: 3 attempts with exponential backoff
   - Fallback: Nominatim API
   - Fallback: Returns error if all strategies fail

2. **Yelp API Failures**
   - Rate limit handling: Automatic retry with backoff
   - Quota exceeded: Blocks processing, returns error
   - Network errors: Retry with exponential backoff
   - Individual hexagon failures: Marked as `'failed'`, processing continues

3. **H3 Grid Generation Failures**
   - `polygonToCells` failure: Falls back to center-based `gridDisk()`
   - Invalid polygon: Returns empty grid array

4. **Buffering Failures**
   - If `turf.buffer()` fails: Returns original polygon

## 🚀 Getting Started

### **Prerequisites**
- Node.js 18+
- npm or yarn
- Yelp Fusion API key

### **Installation**
```bash
# Clone the repository
git clone <repository-url>
cd cylone2

# Install dependencies
npm install

# Set up environment variables
# Create .env.local file:
YELP_API_KEY=your_yelp_fusion_api_key

# Start development server
npm run dev
```

### **Environment Configuration**
Create `.env.local`:
```env
YELP_API_KEY=your_yelp_fusion_api_key
```

### **Available Scripts**
```bash
npm run dev    # Start development server with Turbopack
npm run build  # Build for production
npm run start  # Start production server
npm run lint   # Run ESLint
```

## 📊 Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── city/route.ts      # City boundary API endpoint
│   │   └── yelp/route.ts      # Yelp processing API endpoint
│   ├── globals.css            # Global styles
│   ├── layout.tsx             # Root layout
│   └── page.tsx               # Main page component
├── components/
│   ├── CityMap/               # Map components
│   │   ├── CityMapCore.tsx    # Core map rendering logic
│   │   ├── HexagonDisplay.tsx # Business data display
│   │   ├── MapControls.tsx   # Layer visibility controls
│   │   └── YelpIntegration.tsx # Yelp processing UI
│   └── CityMap.tsx            # Main map wrapper
└── lib/
    ├── geo.ts                 # Geographic utilities & boundary fetching
    ├── yelpSearch.ts          # Yelp API integration & search logic
    ├── hexagonCoverage.ts     # Search point generation strategies
    ├── hexagonProcessor.ts    # Two-phase processing pipeline
    ├── hexagonSplitter.ts     # Dense hexagon subdivision logic
    ├── apiQuotaManager.ts     # Quota tracking & estimation
    ├── rateLimiter.ts         # Rate limiting implementation
    └── overpassStrategies.ts  # Overpass API query strategies
```

## 🌍 Example Cities to Try

- **Miami, FL** - Large city with complex boundary
- **Key Biscayne, FL** - Island municipality
- **San Francisco, CA** - Peninsula city
- **Manhattan, NY** - Dense urban area (will trigger subdivision)

## 📈 Performance Considerations

- **API Efficiency**: Multi-point searches ensure complete coverage
- **Rate Limiting**: Prevents quota exhaustion
- **Quota Management**: Real-time tracking and optimization
- **Error Recovery**: Automatic retry with exponential backoff
- **Marker Clustering**: Optimized map performance for large datasets

## 🚀 Deployment

### **Vercel (Recommended)**
```bash
npm i -g vercel
vercel
# Set YELP_API_KEY in Vercel dashboard
```

## 📄 License

MIT License

## 🙏 Acknowledgments

- [OpenStreetMap](https://www.openstreetmap.org/) for geographic data
- [Nominatim](https://nominatim.org/) for geocoding services
- [Yelp Fusion API](https://www.yelp.com/developers/documentation/v3) for business data
- [H3](https://h3geo.org/) for hexagon grid system
- [Leaflet](https://leafletjs.com/) for mapping capabilities

---

**Built with ❤️ using Next.js, TypeScript, and advanced geospatial processing techniques.**
