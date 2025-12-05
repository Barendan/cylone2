'use client';

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import L from 'leaflet';
import type { EnhancedCityResponse } from '@/lib/geography/cityTypes';
import type { YelpBusiness } from '@/lib/yelp/search';
import CityMapCore from './CityMapCore';
import MapControls from './MapControls';
import YelpIntegration from './YelpIntegration';
import RestaurantReviewPanel from './RestaurantReviewPanel';

// Define interfaces for Yelp testing state
interface Restaurant {
  id: string;
  name: string;
  rating: number;
  review_count: number;
  price: string;
  categories: Array<{ alias: string; title: string }>;
  coordinates: { latitude: number; longitude: number };
  location: {
    address1: string;
    city: string;
    state: string;
    zip_code: string;
  };
  phone: string;
  url: string;
  distance: number;
}

interface HexagonResult {
  h3Id: string;
  mapIndex?: number; // Map hexagon number for correlation
  status: 'fetched' | 'failed' | 'dense' | 'split';
  totalBusinesses: number;
  uniqueBusinesses: Restaurant[];
  searchResults: Restaurant[];
  coverageQuality: string;
  error?: string;
}

export interface YelpTestResult {
  success?: boolean;
  results?: HexagonResult[];
  newBusinesses?: Restaurant[]; // Only new restaurants added to staging
  testMode?: boolean;
  processedAt?: string;
  error?: string;
  fromCache?: boolean; // Flag to indicate data loaded from cache vs fresh search
  importLogId?: string | null; // Import log ID for tracking approved restaurants
  cityId?: string | null; // City ID for creating staging records
  processingStats?: {
    totalHexagons: number;
    processedHexagons: number;
    successfulHexagons: number;
    failedHexagons: number;
    limitedHexagons: number;
    totalRequested: number;
    restaurantsFetched?: number;
    duplicatesSkipped?: number;
    validationErrors?: number;
    newRestaurantsCount?: number;
  };
}

interface CityMapProps {
  cityData: EnhancedCityResponse | null;
  onRestaurantDataChange?: (data: YelpTestResult | null) => void;
}

export default function CityMap({ cityData, onRestaurantDataChange }: CityMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const hasLoadedCacheRef = useRef<string | null>(null); // Track which city we've loaded cache for
  
  // Layer visibility state
  const [showBuffered, setShowBuffered] = useState(true);
  const [showH3Grid, setShowH3Grid] = useState(true);
  const [showHexagonNumbers, setShowHexagonNumbers] = useState(true);
  const [showRestaurants, setShowRestaurants] = useState(true);

  // Yelp testing state
  const [yelpResults, setYelpResults] = useState<YelpTestResult | null>(null);
  const [isLoadingCache, setIsLoadingCache] = useState(false);

  // Map ready callback - MUST be memoized to prevent map destruction
  const handleMapReady = useCallback((map: L.Map) => {
    mapRef.current = map;
  }, []); // Empty deps - this function never changes

  // Toggle layer visibility
  const toggleBuffered = () => {
    setShowBuffered(!showBuffered);
  };

  const toggleH3Grid = () => {
    setShowH3Grid(!showH3Grid);
  };

  const toggleHexagonNumbers = () => {
    setShowHexagonNumbers(!showHexagonNumbers);
  };

  const toggleRestaurants = () => {
    setShowRestaurants(!showRestaurants);
  };

  // Get all unique restaurants from Yelp results - memoized to prevent unnecessary re-renders
  const allRestaurants = useMemo((): YelpBusiness[] => {
    if (!yelpResults?.results) return [];
    const allBusinesses = yelpResults.results.flatMap(result => result.uniqueBusinesses || []);
    
    // Deduplicate by business ID (same logic as HexagonDisplay)
    const uniqueMap = new Map<string, YelpBusiness>();
    allBusinesses.forEach(business => {
      if (!uniqueMap.has(business.id)) {
        uniqueMap.set(business.id, business as YelpBusiness);
      }
    });
    
    return Array.from(uniqueMap.values());
  }, [yelpResults?.results]); // Only recalculate when yelpResults changes

  // Handle Yelp results update
  const handleYelpResultsUpdate = (results: YelpTestResult) => {
    setYelpResults(results);
    // Notify parent component of restaurant data changes
    onRestaurantDataChange?.(results);
  };

  // Automatically load cached restaurant data when city changes
  useEffect(() => {
    // Check if city has cached restaurant data available
    const hasCachedData = (cityData as any)?.cachedRestaurantData?.available === true;
    const cityId = (cityData as any)?.city_id;
    
    // If city changed (different ID), clear previous results and reset tracking
    if (cityData && hasLoadedCacheRef.current !== cityId) {
      setYelpResults(null);
      onRestaurantDataChange?.(null); // Notify parent that data is cleared
      hasLoadedCacheRef.current = null;
    }
    
    // Skip if no cached data, no city ID, or we've already loaded this city's cache
    if (!hasCachedData || !cityId || hasLoadedCacheRef.current === cityId) {
      return;
    }
    
    // Automatically load cached data
    const loadCachedData = async () => {
      setIsLoadingCache(true);
      hasLoadedCacheRef.current = cityId; // Mark this city as loaded
      
      try {
        console.log('📦 Auto-loading cached restaurants for city:', cityId);
        
        const response = await fetch('/api/yelp/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'load_cached',
            city_id: cityId
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to load cache: ${response.status}`);
        }

        const result = await response.json();
        
        // Set the results - this will trigger restaurant display on map
        setYelpResults(result);
        // Notify parent component of restaurant data changes
        onRestaurantDataChange?.(result);
        
        console.log(`✅ Auto-loaded ${result.processingStats?.totalRequested || 0} cached restaurants`);
        
      } catch (error) {
        console.error('❌ Failed to auto-load cached restaurants:', error);
        // Reset the ref so user can retry if they want
        hasLoadedCacheRef.current = null;
        // Fail silently - don't break the UI
      } finally {
        setIsLoadingCache(false);
      }
    };
    
    loadCachedData();
  }, [cityData]);

  // Recenter map on city boundary
  const recenterMap = () => {
    if (!mapRef.current || !cityData) return;
    
    const map = mapRef.current;
    // Create a temporary layer to get bounds from the city geojson
    const tempLayer = L.geoJSON(cityData.geojson);
    const bounds = tempLayer.getBounds();
    
    if (bounds.isValid()) {
      // Invalidate size first to ensure map dimensions are correct
      map.invalidateSize();
      
      // Fit bounds to city
      map.fitBounds(bounds, {
        padding: [24, 24],
        maxZoom: 18
      });
      
      // Force a complete refresh after the view change
      // This ensures all layers (H3 grid, boundaries, etc.) are properly redrawn
      setTimeout(() => {
        // Invalidate size again after view change
        map.invalidateSize();
        
        // Force redraw by temporarily toggling zoom (triggers layer refresh)
        const currentZoom = map.getZoom();
        map.setZoom(currentZoom);
        
        // Ensure all canvas-based layers refresh
        map.eachLayer((layer) => {
          // For GeoJSON layers
          if (layer instanceof L.GeoJSON) {
            layer.eachLayer((featureLayer) => {
              if (featureLayer instanceof L.Path) {
                featureLayer.redraw();
              }
            });
          }
          // For LayerGroups (like H3 grid)
          if (layer instanceof L.LayerGroup) {
            layer.eachLayer((sublayer) => {
              if (sublayer instanceof L.Path) {
                sublayer.redraw();
              }
              // Markers don't need explicit update - they refresh automatically
            });
          }
          // For direct Path layers
          if (layer instanceof L.Path) {
            layer.redraw();
          }
        });
      }, 150);
    }
  };

  return (
    <div className="space-y-4">
      {/* Map Container - First, at the top */}
      <div 
        className="relative w-full rounded-lg overflow-hidden border border-gray-200 bg-gray-100"
        style={{ height: '500px', minHeight: '500px' }}
      >
        <div 
          id="map" 
          className="w-full h-full"
        />
        {/* Recenter Button - Overlay on map */}
        {cityData && (
          <button
            onClick={recenterMap}
            className="absolute top-4 right-4 bg-white hover:bg-gray-50 border border-gray-300 rounded shadow-md p-2 transition-all duration-200 hover:shadow-lg z-[1000] flex items-center justify-center"
            title="Recenter map on city boundary"
            style={{
              boxShadow: '0 1px 5px rgba(0,0,0,0.4)'
            }}
          >
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
              className="text-gray-700"
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
        )}
      </div>
      
      {/* Map Core Component (handles map logic) */}
      <CityMapCore
        cityData={cityData}
        showBuffered={showBuffered}
        showH3Grid={showH3Grid}
        showHexagonNumbers={showHexagonNumbers}
        showRestaurants={showRestaurants}
        restaurants={allRestaurants}
        restaurantData={yelpResults}
        onMapReady={handleMapReady}
      />

      {/* Layer Controls - Below the map */}
      <MapControls
        cityData={cityData}
        showBuffered={showBuffered}
        showH3Grid={showH3Grid}
        showHexagonNumbers={showHexagonNumbers}
        showRestaurants={showRestaurants}
        onToggleBuffered={toggleBuffered}
        onToggleH3Grid={toggleH3Grid}
        onToggleHexagonNumbers={toggleHexagonNumbers}
        onToggleRestaurants={toggleRestaurants}
      />

      {/* Yelp Integration - Below controls */}
      <YelpIntegration
        cityData={cityData}
        onResultsUpdate={handleYelpResultsUpdate}
      />

      {/* Restaurant Review Panel */}
      <RestaurantReviewPanel yelpResults={yelpResults} />

    </div>
  );
}
