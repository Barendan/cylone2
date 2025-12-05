import { NextResponse } from 'next/server';
import { YelpSearchEngine, type HexagonYelpResult } from '@/lib/yelp/search';
import { hexagonProcessor } from '@/lib/hexagons/processor';
import { yelpQuotaManager } from '@/lib/utils/quotaManager';
import { getCityByName } from '@/lib/database/cities';
import { getValidHextile, upsertHextile, getHextileCenter } from '@/lib/database/hextiles';
import { createImportLog, updateImportLog } from '@/lib/database/importLogs';
import { parseCityInput } from '@/lib/database/cityConverter';
import { getStagingBusinessesAsYelpBusinesses } from '@/lib/database/yelpStaging';
import { processingStates, type ProcessingState } from './state';
import * as h3 from 'h3-js';

// Initialize Yelp search engine
const yelpEngine = new YelpSearchEngine(process.env.YELP_API_KEY || 'demo-key');

/**
 * Process hexagons with Yelp search
 * Handles two-phase processing: Phase 1 (resolution 7) and Phase 2 (subdivision resolution 8)
 */
export async function processHexagons(
  hexagons: string[] | Array<{ h3Id: string; mapIndex: number; originalIndex: number }>, 
  testMode: boolean = false,
  cityName?: string
): Promise<NextResponse> {
  try {
    if (!hexagons || hexagons.length === 0) {
      return NextResponse.json(
        { error: 'No hexagons provided' },
        { status: 400 }
      );
    }

    // Get city_id from cityName if provided (for database tracking)
    let cityId: string | null = null;
    if (cityName) {
      try {
        const parsed = parseCityInput(cityName);
        if (parsed) {
          let city = await getCityByName(parsed.cityName, parsed.state);
          if (city) {
            cityId = city.id;
            console.log(`✅ Found city in database: ${parsed.cityName}, ${parsed.state} (ID: ${cityId})`);
          } else {
            // City doesn't exist - try to create it
            console.log(`⚠️ City not found in database: ${parsed.cityName}, ${parsed.state} - attempting to create...`);
            const { createCity } = await import('@/lib/database/cities');
            const newCityId = await createCity({
              name: parsed.cityName,
              state: parsed.state,
              country: 'USA'
            });
            if (newCityId) {
              cityId = newCityId;
              console.log(`✅ Created new city in database: ${parsed.cityName}, ${parsed.state} (ID: ${cityId})`);
            } else {
              console.error(`❌ Failed to create city in database: ${parsed.cityName}, ${parsed.state} - import logs and staging will be skipped`);
            }
          }
        } else {
          console.warn(`⚠️ Could not parse city name: "${cityName}" - import logs and staging will be skipped`);
        }
      } catch (dbError) {
        // Graceful degradation: continue without city_id if lookup fails
        console.error('❌ Error getting/creating city_id for import log (non-fatal, but import logs and staging will be skipped):', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
          cityName
        });
      }
    } else {
      console.warn('⚠️ No cityName provided - import logs and staging will be skipped');
    }

    // Check quota before processing
    const quotaEstimate = yelpQuotaManager.estimateQuotaForCity(hexagons.length, 7, 1.5);
    
    if (!quotaEstimate.canProcessRequest && !testMode) {
      return NextResponse.json({
        error: 'Insufficient quota',
        quotaEstimate,
        recommendations: quotaEstimate.recommendations
      }, { status: 429 });
    }
    
    // Additional quota check for test mode
    if (testMode) {
      const maxTestHexagons = 5;
      const estimatedCalls = Math.min(hexagons.length, maxTestHexagons) * 3; // Assume 3 search points per hexagon
      const quotaStatus = yelpQuotaManager.getQuotaStatus();
      
      if (quotaStatus.dailyRemaining < estimatedCalls) {
        return NextResponse.json({
          error: 'Insufficient quota for test',
          quotaStatus,
          estimatedCalls,
          recommendations: ['Wait for quota reset', 'Reduce test size', 'Check daily usage']
        }, { status: 429 });
      }
    }

    // SAFETY CHECK: Strict limit for test mode to prevent quota abuse
    let hexagonsToProcess: string[] = [];
    let hexagonIndices: number[] = [];
    
    // Handle both string[] and object[] formats, preserving indices
    if (Array.isArray(hexagons) && hexagons.length > 0) {
      if (typeof hexagons[0] === 'string') {
        // Legacy format: string[]
        hexagonIndices = hexagons.map((_, index) => index);
        hexagonsToProcess = hexagons as string[];
      } else {
        // New format: Array<{ h3Id: string; mapIndex: number; originalIndex: number }>
        const hexagonData = hexagons as Array<{ h3Id: string; mapIndex: number; originalIndex: number }>;
        hexagonsToProcess = hexagonData.map(h => h.h3Id);
        hexagonIndices = hexagonData.map(h => h.originalIndex);
      }
    }
    
    if (testMode) {
      // Test mode: use real Yelp API calls on limited hexagons
      const maxTestHexagons = 5; // Strict limit for testing
      hexagonsToProcess = hexagonsToProcess.slice(0, maxTestHexagons);
      hexagonIndices = hexagonIndices.slice(0, maxTestHexagons);
    }
    
    // Store total for progress tracking
    const totalHexagons = hexagonsToProcess.length;
    const processId = `process_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create import log for tracking (graceful degradation - continue if this fails)
    let importLogId: string | null = null;
    let actualApiCalls = 0;
    let tilesSkipped = 0;
    let tilesFetched = 0;
    let restaurantsFetched = 0;
    const allNewBusinesses: any[] = []; // Track all new businesses across all hexagons
    
    if (cityId) {
      try {
        const estimatedCalls = Math.ceil(totalHexagons * 3 * 1.5); // Estimate based on hexagon count
        console.log(`📝 Attempting to create import log for city ${cityId} with ${totalHexagons} hexagons...`);
        importLogId = await createImportLog({
          city_id: cityId,
          total_tiles: totalHexagons,
          estimated_api_calls: estimatedCalls,
          test_mode: testMode
        });
        if (importLogId) {
          console.log(`✅ Created import log ${importLogId} for ${totalHexagons} hexagons`);
        } else {
          console.error(`❌ Failed to create import log - function returned null (check database connection)`);
        }
      } catch (logError) {
        console.error('❌ Exception creating import log (non-fatal, but check DB connection):', {
          error: logError instanceof Error ? logError.message : String(logError),
          stack: logError instanceof Error ? logError.stack : undefined,
          cityId
        });
      }
    } else {
      console.warn('⚠️ No cityId provided - skipping import log creation');
    }
    
    // Initialize processing state
    // Estimate total API calls: ~3 per hexagon (3 search points per hexagon)
    const estimatedTotalApiCalls = totalHexagons * 3;
    const processingState: ProcessingState = {
      totalHexagons,
      processedHexagons: 0,
      phase1Total: totalHexagons,
      phase1Processed: 0,
      phase2Total: 0,
      phase2Processed: 0,
      isProcessing: true,
      startTime: Date.now(),
      importLogId: importLogId, // Store for failure handling
      actualApiCalls: 0,
      estimatedTotalApiCalls: estimatedTotalApiCalls,
      lastRestaurantCount: 0
    };
    processingStates.set(processId, processingState);
    
    // Use the unified two-phase processing pipeline
    let results: HexagonYelpResult[] = [];
    
    // Note: Validation and duplicate statistics will be tracked when admin approves restaurants
    
    // Both test and real modes now use the complete two-phase algorithm with Yelp API calls
    try {
      // Phase 1: Process hexagons at resolution 7 with Yelp
      const phase1Results: HexagonYelpResult[] = [];
      
      for (let i = 0; i < hexagonsToProcess.length; i++) {
        const h3Id = hexagonsToProcess[i];
        const mapIndex = hexagonIndices[i];
        
        try {
          // STEP 1: Check cache before processing (graceful degradation)
          let yelpResult: HexagonYelpResult | null = null;
          let fromCache = false;
          
          if (cityId) {
            try {
              const cachedHextile = await getValidHextile(h3Id);
              if (cachedHextile && cachedHextile.yelp_total_businesses !== undefined) {
                // Use cached data - reconstruct HexagonYelpResult
                const center = getHextileCenter(h3Id);
                if (center) {
                  // FIX ISSUE 2: Load businesses from staging when using cache
                  const cachedBusinesses = await getStagingBusinessesAsYelpBusinesses(h3Id);
                  
                  yelpResult = {
                    h3Id,
                    totalBusinesses: cachedHextile.yelp_total_businesses,
                    uniqueBusinesses: cachedBusinesses, // Load from staging
                    searchResults: [], // Search results not cached
                    status: cachedHextile.status === 'dense' ? 'dense' : 'fetched',
                    coverageQuality: 'cached'
                  };
                  fromCache = true;
                  tilesSkipped++;
                  console.log(`✅ Using cached data for hexagon ${h3Id} (${cachedBusinesses.length} businesses loaded from staging)`);
                }
              }
            } catch (cacheError) {
              // Graceful degradation: continue with normal processing if cache check fails
              console.warn(`Cache check failed for ${h3Id} (non-fatal):`, cacheError);
            }
          }
          
          // STEP 2: Process with Yelp API if not cached
          if (!fromCache) {
            yelpResult = await yelpEngine.searchHexagon(h3Id);
            actualApiCalls += 3; // Approximate API calls per hexagon (3 search points)
            tilesFetched++;
            restaurantsFetched += yelpResult.uniqueBusinesses.length;
            
            // Update processing state with API call and restaurant count
            processingState.actualApiCalls = actualApiCalls;
            processingState.lastRestaurantCount = yelpResult.totalBusinesses;
          }
          
          // Ensure we have a valid result
          if (!yelpResult) {
            throw new Error('Failed to get Yelp result for hexagon');
          }
          
          // Update last restaurant count for display (even if cached)
          processingState.lastRestaurantCount = yelpResult.totalBusinesses;
          
          // Add map index to the result
          const resultWithIndex = { ...yelpResult, mapIndex };
          phase1Results.push(resultWithIndex);
          
          // Update hexagon processor with Yelp results
          await hexagonProcessor.processHexagonWithCoverage(h3Id, 7, {
            totalBusinesses: yelpResult.totalBusinesses,
            status: yelpResult.status,
            coverageQuality: yelpResult.coverageQuality
          });
          
          // STEP 3: Hexagons are saved when restaurants are approved (see staging API)
          // This ensures atomic consistency - hexagons only exist if they have approved restaurants
          
          // STEP 4: Restaurants AND hexagons saved to database when admin approves (see staging API)
          // No automatic saving during search - results are returned to frontend for review
          if (yelpResult.uniqueBusinesses && yelpResult.uniqueBusinesses.length > 0) {
            // Track businesses for response (but don't save to staging yet)
            allNewBusinesses.push(...yelpResult.uniqueBusinesses);
          }
          
          // Check if this hexagon needs subdivision
          if (yelpResult.status === 'split' && yelpResult.totalBusinesses > 240) {
            // The subdivision is already handled in YelpSearchEngine.processSearchResults
          }
          
          // Update progress
          processingState.phase1Processed = i + 1;
          processingState.processedHexagons = processingState.phase1Processed;
          
          // Update import log periodically (every 10 hexagons or at end)
          if (importLogId && (i % 10 === 0 || i === hexagonsToProcess.length - 1)) {
            try {
              await updateImportLog(importLogId, {
                processed_tiles: i + 1,
                actual_api_calls: actualApiCalls,
                tiles_skipped: tilesSkipped,
                tiles_fetched: tilesFetched,
                restaurants_fetched: restaurantsFetched
              });
            } catch (logError) {
              // Non-fatal: continue processing
              console.warn('Failed to update import log (non-fatal):', logError);
            }
          }
          
        } catch (error) {
          console.error(`❌ Phase 1: Error processing hexagon ${h3Id}:`, error);
          phase1Results.push({
            h3Id,
            mapIndex, // Include the map index for correlation
            totalBusinesses: 0,
            uniqueBusinesses: [],
            searchResults: [],
            status: 'failed',
            coverageQuality: 'unknown',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          
          // Save failed status to database
          if (cityId) {
            try {
              const center = getHextileCenter(h3Id);
              if (center) {
                const resolution = h3.getResolution(h3Id);
                await upsertHextile({
                  h3_id: h3Id,
                  city_id: cityId,
                  status: 'failed',
                  center_lat: center.lat,
                  center_lng: center.lng,
                  resolution: resolution,
                  retry_count: 1
                });
              }
            } catch (saveError) {
              // Non-fatal
              console.warn(`Failed to save failed hextile ${h3Id} (non-fatal):`, saveError);
            }
          }
        }
      }
      
      // Phase 2: Process subdivision queue (resolution 8 hexagons)
      const subdivisionResults = await hexagonProcessor.processSubdivisionQueue();
      const subdivisionCount = subdivisionResults.length;
      processingState.phase2Total = subdivisionCount;
      processingState.totalHexagons = totalHexagons + subdivisionCount;
      
      // Process subdivision hexagons with Yelp
      const phase2Results: HexagonYelpResult[] = [];
      let phase2Index = 0;
      for (const subdivisionHex of subdivisionResults) {
        if (subdivisionHex.status === 'fetched') {
          try {
            const h3Id = subdivisionHex.h3Id;
            
            // STEP 1: Check cache before processing (graceful degradation)
            let yelpResult: HexagonYelpResult | null = null;
            let fromCache = false;
            
            if (cityId) {
              try {
                const cachedHextile = await getValidHextile(h3Id);
                if (cachedHextile && cachedHextile.yelp_total_businesses !== undefined) {
                  const center = getHextileCenter(h3Id);
                  if (center) {
                    // FIX ISSUE 2: Load businesses from staging when using cache
                    const cachedBusinesses = await getStagingBusinessesAsYelpBusinesses(h3Id);
                    
                    yelpResult = {
                      h3Id,
                      totalBusinesses: cachedHextile.yelp_total_businesses,
                      uniqueBusinesses: cachedBusinesses, // Load from staging
                      searchResults: [], // Search results not cached
                      status: cachedHextile.status === 'dense' ? 'dense' : 'fetched',
                      coverageQuality: 'cached'
                    };
                    fromCache = true;
                    tilesSkipped++;
                    console.log(`✅ Using cached data for subdivision hexagon ${h3Id} (${cachedBusinesses.length} businesses loaded from staging)`);
                  }
                }
              } catch (cacheError) {
                console.warn(`Cache check failed for subdivision ${h3Id} (non-fatal):`, cacheError);
              }
            }
            
            // STEP 2: Process with Yelp API if not cached
            if (!fromCache) {
              yelpResult = await yelpEngine.searchHexagon(h3Id);
              actualApiCalls += 3; // Approximate API calls per hexagon
              tilesFetched++;
              restaurantsFetched += yelpResult.uniqueBusinesses.length;
              
              // Update processing state with API call
              processingState.actualApiCalls = actualApiCalls;
            }
            
            // Ensure we have a valid result
            if (!yelpResult) {
              throw new Error('Failed to get Yelp result for subdivision hexagon');
            }
            
            // Update last restaurant count for display (even if cached)
            processingState.lastRestaurantCount = yelpResult.totalBusinesses;
            
            phase2Results.push(yelpResult);
            
            // STEP 3: Phase 2 hexagons are saved when restaurants are approved (see staging API)
            // This ensures atomic consistency - hexagons only exist if they have approved restaurants
            
            // STEP 4: Restaurants AND hexagons saved to database when admin approves (see staging API)
            // No automatic saving during Phase 2 - results are returned to frontend for review
            if (yelpResult.uniqueBusinesses && yelpResult.uniqueBusinesses.length > 0) {
              // Track businesses for response (but don't save to staging yet)
              allNewBusinesses.push(...yelpResult.uniqueBusinesses);
            }
            
            // Update progress
            phase2Index++;
            processingState.phase2Processed = phase2Index;
            processingState.processedHexagons = processingState.phase1Processed + processingState.phase2Processed;
            
            // Update import log periodically
            if (importLogId && phase2Index % 10 === 0) {
              try {
                await updateImportLog(importLogId, {
                  processed_tiles: processingState.phase1Processed + phase2Index,
                  actual_api_calls: actualApiCalls,
                  tiles_skipped: tilesSkipped,
                  tiles_fetched: tilesFetched,
                  restaurants_fetched: restaurantsFetched
                });
              } catch (logError) {
                console.warn('Failed to update import log (non-fatal):', logError);
              }
            }
            
          } catch (error) {
            console.error(`❌ Phase 2: Error processing subdivision hexagon ${subdivisionHex.h3Id}:`, error);
            phase2Results.push({
              h3Id: subdivisionHex.h3Id,
              totalBusinesses: 0,
              uniqueBusinesses: [],
              searchResults: [],
              status: 'failed',
              coverageQuality: 'unknown',
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            
            // Save failed status to database
            if (cityId) {
              try {
                const center = getHextileCenter(subdivisionHex.h3Id);
                if (center) {
                  const resolution = h3.getResolution(subdivisionHex.h3Id);
                  await upsertHextile({
                    h3_id: subdivisionHex.h3Id,
                    city_id: cityId,
                    status: 'failed',
                    center_lat: center.lat,
                    center_lng: center.lng,
                    resolution: resolution,
                    retry_count: 1
                  });
                }
              } catch (saveError) {
                console.warn(`Failed to save failed subdivision hextile (non-fatal):`, saveError);
              }
            }
          }
        }
      }
      
      // Combine all results
      results = [...phase1Results, ...phase2Results];
      
    } catch (error) {
      console.error(`❌ Error in two-phase processing:`, error);
      throw error;
    }

    // Mark processing as complete
    processingState.isProcessing = false;
    
    // Update import log as complete (graceful degradation)
    if (importLogId) {
      try {
        const totalProcessed = processingState.phase1Processed + processingState.phase2Processed;
        const totalSkipped = tilesSkipped;
        const totalFetched = tilesFetched;
        
        // Count total businesses saved to staging (approximate - actual count would require query)
        // For now, use restaurants_fetched as approximation
        await updateImportLog(importLogId, {
          status: 'complete',
          processed_tiles: totalProcessed,
          actual_api_calls: actualApiCalls,
          tiles_skipped: totalSkipped,
          tiles_fetched: totalFetched,
          restaurants_fetched: restaurantsFetched,
          restaurants_added: restaurantsFetched, // Approximation - actual count would require querying staging table
          end_time: new Date().toISOString()
        });
        console.log(`✅ Marked import log ${importLogId} as complete`);
      } catch (logError) {
        console.warn('Failed to mark import log as complete (non-fatal):', logError);
      }
    }
    
    // Get comprehensive processing statistics and subdivision information
    const processingStats = hexagonProcessor.getProcessingStats();
    const quotaStatus = yelpQuotaManager.getQuotaStatus();
    const subdivisionQueueStatus = hexagonProcessor.getSubdivisionQueueStatus();
    const resultsByResolution = hexagonProcessor.getResultsByResolution();
    const mergedResults = hexagonProcessor.getMergedResults();

    // Clean up processing state after a delay
    setTimeout(() => {
      processingStates.delete(processId);
    }, 60000); // Keep for 1 minute after completion

    // Deduplicate businesses by ID (businesses can appear in multiple hexagons)
    const uniqueBusinessesMap = new Map<string, any>();
    allNewBusinesses.forEach(business => {
      if (business && business.id && !uniqueBusinessesMap.has(business.id)) {
        uniqueBusinessesMap.set(business.id, business);
      }
    });
    const uniqueBusinesses = Array.from(uniqueBusinessesMap.values());

    return NextResponse.json({
      success: true,
      results,
      newBusinesses: uniqueBusinesses, // All unique businesses from search (not yet saved to staging)
      processingStats: {
        ...processingStats,
        restaurantsFetched: restaurantsFetched,
        newRestaurantsCount: uniqueBusinesses.length
      },
      // Include metadata needed for approval workflow
      importLogId: importLogId || null,
      cityId: cityId || null,
      quotaStatus,
      subdivisionQueueStatus,
      resultsByResolution,
      mergedResults,
      testMode,
      limitedHexagons: testMode ? Math.min(hexagons.length, 10) : hexagons.length,
      totalRequested: hexagons.length,
      totalProcessed: processingState.totalHexagons,
      processedAt: new Date().toISOString(),
      // Include cache statistics
      cacheStats: {
        tilesSkipped,
        tilesFetched,
        actualApiCalls
      }
    });

  } catch (error) {
    // Mark processing as failed
    const processId = Array.from(processingStates.keys()).find(id => processingStates.get(id)?.isProcessing);
    let importLogIdToFail: string | null = null;
    
    if (processId) {
      const state = processingStates.get(processId);
      if (state) {
        state.isProcessing = false;
        importLogIdToFail = state.importLogId || null; // FIX ISSUE 1: Get importLogId from state
        setTimeout(() => processingStates.delete(processId), 60000);
      }
    }
    
    // FIX ISSUE 1: Mark import log as failed (graceful degradation)
    if (importLogIdToFail) {
      try {
        await updateImportLog(importLogIdToFail, {
          status: 'failed',
          end_time: new Date().toISOString()
        });
        console.log(`✅ Marked import log ${importLogIdToFail} as failed`);
      } catch (logError) {
        console.warn('Failed to mark import log as failed (non-fatal):', logError);
      }
    }
    
    console.error('Error processing hexagons:', error);
    return NextResponse.json(
      { error: 'Failed to process hexagons', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

