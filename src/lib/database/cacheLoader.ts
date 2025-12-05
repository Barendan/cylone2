// Database helper functions for loading cached restaurant data
import { supabaseServer } from '../config/supabaseServer';
import { getHextilesByCity } from './hextiles';
import { getStagingBusinessesAsYelpBusinesses } from './yelpStaging';
import type { YelpBusiness } from '../yelp/search';

// Interface matching the HexagonResult structure used in the frontend
export interface CachedHexagonResult {
  h3Id: string;
  mapIndex?: number;
  status: 'fetched' | 'failed' | 'dense' | 'split';
  totalBusinesses: number;
  uniqueBusinesses: YelpBusiness[];
  searchResults: YelpBusiness[]; // For cached data, this is the same as uniqueBusinesses
  coverageQuality: string;
  error?: string;
}

export interface CachedRestaurantData {
  hexagons: CachedHexagonResult[];
  totalRestaurants: number;
  totalHexagons: number;
  cacheDate: string;
}

/**
 * Get cached restaurant data for a city
 * Returns structured data ready for frontend consumption
 * 
 * @param cityId - The city UUID to fetch cached data for
 * @returns Cached data or null if no data available
 */
export async function getCachedRestaurantData(cityId: string): Promise<CachedRestaurantData | null> {
  try {
    console.log(`📦 Loading cached restaurant data for city: ${cityId}`);
    
    // STEP 1: Get all successfully processed hexagons for this city
    const hextiles = await getHextilesByCity(cityId);
    
    if (!hextiles || hextiles.length === 0) {
      console.log(`⚠️ No cached hexagons found for city: ${cityId}`);
      return null;
    }
    
    // Filter to only successfully fetched hexagons
    const validHextiles = hextiles.filter(
      hex => hex.status === 'fetched' || hex.status === 'dense'
    );
    
    if (validHextiles.length === 0) {
      console.log(`⚠️ No valid hexagons (fetched/dense) found for city: ${cityId}`);
      return null;
    }
    
    console.log(`✅ Found ${validHextiles.length} valid hexagons for city`);
    
    // STEP 2: For each hexagon, get the cached restaurants
    const hexagonResults: CachedHexagonResult[] = [];
    let totalRestaurantCount = 0;
    let oldestCacheDate = new Date();
    
    for (let i = 0; i < validHextiles.length; i++) {
      const hextile = validHextiles[i];
      
      try {
        // Get restaurants from staging table
        const restaurants = await getStagingBusinessesAsYelpBusinesses(hextile.h3_id);
        
        // Skip hexagons with no restaurants (zombie hexagons from old system)
        if (restaurants.length === 0) {
          console.log(`⏭️ Skipping hexagon ${hextile.h3_id} - no restaurants found`);
          continue;
        }
        
        // Track oldest cache date
        const hexCreatedAt = new Date(hextile.created_at);
        if (hexCreatedAt < oldestCacheDate) {
          oldestCacheDate = hexCreatedAt;
        }
        
        // Create result matching frontend structure
        const hexagonResult: CachedHexagonResult = {
          h3Id: hextile.h3_id,
          mapIndex: i, // Sequential index for display
          status: hextile.status as 'fetched' | 'dense',
          totalBusinesses: restaurants.length,
          uniqueBusinesses: restaurants,
          searchResults: restaurants, // For cached data, these are the same
          coverageQuality: hextile.status === 'dense' ? 'dense' : 'good'
        };
        
        hexagonResults.push(hexagonResult);
        totalRestaurantCount += restaurants.length;
        
      } catch (hexError) {
        console.warn(`⚠️ Failed to load restaurants for hexagon ${hextile.h3_id}:`, hexError);
        // Continue with other hexagons even if one fails
      }
    }
    
    if (hexagonResults.length === 0) {
      console.log(`⚠️ No hexagons with restaurants found for city: ${cityId}`);
      return null;
    }
    
    console.log(`✅ Successfully loaded ${totalRestaurantCount} restaurants across ${hexagonResults.length} hexagons`);
    
    return {
      hexagons: hexagonResults,
      totalRestaurants: totalRestaurantCount,
      totalHexagons: hexagonResults.length,
      cacheDate: oldestCacheDate.toISOString()
    };
    
  } catch (error) {
    console.error('❌ Error loading cached restaurant data:', error);
    return null;
  }
}

/**
 * Check if city has cached restaurant data
 * Lightweight query for status checking
 * 
 * @param cityId - The city UUID to check
 * @returns Cache status information
 */
export async function checkCacheStatus(cityId: string): Promise<{
  hasCachedData: boolean;
  hexagonCount: number;
  estimatedRestaurants: number;
}> {
  try {
    // Query count of successfully processed hexagons
    const { count: hexagonCount, error } = await supabaseServer
      .from('yelp_hextiles')
      .select('h3_id', { count: 'exact', head: true })
      .eq('city_id', cityId)
      .in('status', ['fetched', 'dense']);
    
    if (error) {
      console.error('Error checking cache status:', error);
      return {
        hasCachedData: false,
        hexagonCount: 0,
        estimatedRestaurants: 0
      };
    }
    
    const finalCount = hexagonCount || 0;
    
    // Get sum of total businesses from hexagons for better estimate
    const { data: hexagons } = await supabaseServer
      .from('yelp_hextiles')
      .select('yelp_total_businesses')
      .eq('city_id', cityId)
      .in('status', ['fetched', 'dense']);
    
    const estimatedRestaurants = hexagons?.reduce(
      (sum, hex) => sum + (hex.yelp_total_businesses || 0), 
      0
    ) || 0;
    
    return {
      hasCachedData: finalCount > 0,
      hexagonCount: finalCount,
      estimatedRestaurants
    };
    
  } catch (error) {
    console.error('Exception checking cache status:', error);
    return {
      hasCachedData: false,
      hexagonCount: 0,
      estimatedRestaurants: 0
    };
  }
}

