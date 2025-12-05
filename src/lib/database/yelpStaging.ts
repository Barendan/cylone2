// Database helper functions for Yelp business staging (yelp_staging table)
import { supabaseServer } from '../config/supabaseServer';
import type { YelpStaging, YelpStagingStatus } from '../types';
import type { YelpBusiness } from '../yelp/search';
import { validateYelpBusiness, logValidationError, type ValidationContext } from '../yelp/validation';

/**
 * Check if a business already exists in staging
 * Returns the existing staging record if found, null otherwise
 * 
 * @param yelpId - The Yelp business ID to check
 * @param excludeStatuses - Optional array of statuses to exclude from duplicate check.
 *                          If provided, businesses with these statuses won't be considered duplicates.
 *                          Use case: exclude 'approved' when checking for duplicates during import.
 * @returns The existing staging record if found (and not excluded), null otherwise
 */
export async function checkDuplicateBusiness(
  yelpId: string,
  excludeStatuses?: YelpStagingStatus[]
): Promise<YelpStaging | null> {
  try {
    // Input validation
    if (!yelpId || typeof yelpId !== 'string' || yelpId.trim().length === 0) {
      console.warn('⚠️ checkDuplicateBusiness: Invalid yelpId provided');
      return null;
    }

    let query = supabaseServer
      .from('yelp_staging')
      .select('*')
      .eq('id', yelpId);

    // If excludeStatuses is provided, exclude those statuses
    if (excludeStatuses && excludeStatuses.length > 0) {
      // Use .not() with .in() to exclude multiple statuses
      for (const status of excludeStatuses) {
        query = query.neq('status', status);
      }
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error('Error checking duplicate business in database:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Exception checking duplicate business in database:', error);
    return null;
  }
}

/**
 * Check multiple businesses for duplicates in a single query
 * More efficient than calling checkDuplicateBusiness in a loop
 * Returns map of yelpId -> existing record
 * 
 * @param yelpIds - Array of Yelp business IDs to check
 * @returns Map of yelpId to existing staging record
 */
export async function batchCheckDuplicates(
  yelpIds: string[]
): Promise<Map<string, YelpStaging>> {
  try {
    if (!yelpIds || yelpIds.length === 0) {
      return new Map();
    }

    const { data, error } = await supabaseServer
      .from('yelp_staging')
      .select('*')
      .in('id', yelpIds);

    if (error) {
      console.error('Error batch checking duplicates:', error);
      return new Map();
    }

    // Create map of yelpId -> existing record
    const duplicateMap = new Map<string, YelpStaging>();
    data?.forEach(record => {
      duplicateMap.set(record.id, record);
    });

    return duplicateMap;
  } catch (error) {
    console.error('Exception batch checking duplicates:', error);
    return new Map();
  }
}

/**
 * Get all staging businesses for a hexagon
 * Returns array of staging records, or empty array on error
 */
export async function getStagingBusinessesByHexagon(h3Id: string): Promise<YelpStaging[]> {
  try {
    const { data, error } = await supabaseServer
      .from('yelp_staging')
      .select('*')
      .eq('h3_id', h3Id);

    if (error) {
      console.error('Error fetching staging businesses by hexagon from database:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Exception fetching staging businesses by hexagon from database:', error);
    return [];
  }
}

/**
 * Get staging businesses and convert to YelpBusiness format
 * Useful for reconstructing HexagonYelpResult from cache
 */
export async function getStagingBusinessesAsYelpBusinesses(h3Id: string): Promise<YelpBusiness[]> {
  try {
    const stagingRecords = await getStagingBusinessesByHexagon(h3Id);
    
    // Filter to only 'new' or 'approved' status (exclude 'rejected' and 'duplicate')
    const validRecords = stagingRecords.filter(
      record => record.status === 'new' || record.status === 'approved'
    );
    
    // Convert staging data to YelpBusiness format
    const businesses: YelpBusiness[] = [];
    for (const record of validRecords) {
      if (record.data && typeof record.data === 'object') {
        // Type assertion - we know this is YelpBusiness from our insert
        const business = record.data as YelpBusiness;
        businesses.push(business);
      }
    }
    
    return businesses;
  } catch (error) {
    console.error('Exception converting staging businesses to YelpBusiness format:', error);
    return [];
  }
}

/**
 * Information about duplicate restaurants found during batch create
 */
export interface DuplicateInfo {
  yelpId: string;              // The Yelp business ID (same as DB id)
  cityId: string;              // City ID of existing record
  h3Id?: string;               // Hexagon ID of existing record
}

/**
 * Batch create staging businesses
 * More efficient than individual creates for large batches
 * Validates all businesses before saving - invalid ones are skipped and logged
 * Returns detailed statistics about the operation
 */
export interface BatchCreateStats {
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  newBusinesses: YelpBusiness[]; // Actual businesses that were newly inserted
  duplicates: DuplicateInfo[];   // Details about each duplicate found
}

export async function batchCreateYelpStaging(
  businesses: YelpBusiness[],
  h3Id: string,
  cityId: string,
  importLogId: string
): Promise<BatchCreateStats> {
  try {
    console.log(`📦 batchCreateYelpStaging called: ${businesses.length} businesses, h3Id: ${h3Id}, cityId: ${cityId}, importLogId: ${importLogId}`);
    
    const context: ValidationContext = {
      h3Id,
      cityId,
      importLogId
    };

    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const newBusinesses: YelpBusiness[] = []; // Track businesses that were actually inserted
    const allDuplicates: DuplicateInfo[] = []; // Track duplicates across all batches
    
    // Process in batches to avoid overwhelming the database
    const batchSize = 50;
    for (let i = 0; i < businesses.length; i += batchSize) {
      const batch = businesses.slice(i, i + batchSize);
      console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}: ${batch.length} businesses`);
      
      // Step 1: Validate all businesses in batch
      const validBusinesses: YelpBusiness[] = [];
      for (const business of batch) {
        const validation = validateYelpBusiness(business, context);
        
        if (!validation.valid) {
          // Log validation error with clear formatting
          logValidationError(business, context, validation.errors);
          errorCount++;
          continue; // Skip invalid business
        }
        
        validBusinesses.push(business);
      }
      
      console.log(`    Validation: ${validBusinesses.length} valid, ${batch.length - validBusinesses.length} invalid`);
      
      // Step 2: Check for duplicates with single batch query
      const businessIds = validBusinesses.map(b => b.id);
      const duplicateMap = await batchCheckDuplicates(businessIds);

      // Build duplicate info array
      const duplicatesInBatch: DuplicateInfo[] = [];
      for (const business of validBusinesses) {
        const existing = duplicateMap.get(business.id);
        if (existing) {
          duplicatesInBatch.push({
            yelpId: business.id,
            cityId: existing.city_id,
            h3Id: existing.h3_id
          });
          skippedCount++;
        }
      }

      // Add to overall duplicates list
      allDuplicates.push(...duplicatesInBatch);

      const existingIds = new Set(duplicateMap.keys());
      console.log(`    Duplicates: ${existingIds.size} found, ${validBusinesses.length - existingIds.size} new`);
      
      // Step 3: Filter out duplicates
      const newBusinessesInBatch = validBusinesses.filter(b => !existingIds.has(b.id));
      
      if (newBusinessesInBatch.length > 0) {
        // Insert new businesses
        const stagingRecords = newBusinessesInBatch.map(business => ({
          id: business.id,
          data: business,
          h3_id: h3Id,
          city_id: cityId,
          yelp_import_log: importLogId,
          status: 'new' as YelpStagingStatus
        }));
        
        console.log(`    Attempting to insert ${newBusinessesInBatch.length} new businesses to database...`);
        const { error } = await supabaseServer
          .from('yelp_staging')
          .insert(stagingRecords);
        
        if (error) {
          console.error('❌ Error batch creating yelp staging:', {
            batchIndex: i,
            batchSize: newBusinessesInBatch.length,
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint,
            h3Id,
            cityId,
            importLogId
          });
          // Continue with next batch even if this one fails
        } else {
          createdCount += newBusinessesInBatch.length;
          newBusinesses.push(...newBusinessesInBatch); // Add newly inserted businesses to the result
          console.log(`    ✅ Successfully inserted ${newBusinessesInBatch.length} businesses to database (total saved: ${createdCount})`);
        }
      } else {
        console.log(`    No new businesses to insert (all duplicates or invalid)`);
      }
    }
    
    // Log summary
    console.log(`📊 batchCreateYelpStaging summary: ${createdCount} saved, ${skippedCount} duplicates skipped, ${errorCount} validation errors`);
    
    return {
      createdCount,
      skippedCount,
      errorCount,
      newBusinesses,
      duplicates: allDuplicates
    };
  } catch (error) {
    console.error('❌ Exception in batchCreateYelpStaging:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      h3Id,
      cityId,
      importLogId,
      businessCount: businesses.length
    });
    return {
      createdCount: 0,
      skippedCount: 0,
      errorCount: businesses.length, // Assume all failed on exception
      newBusinesses: [],
      duplicates: []
    };
  }
}

/**
 * Update the status of a single staging business
 * 
 * @param yelpId - The Yelp business ID to update
 * @param status - The new status to set ('new' | 'duplicate' | 'approved' | 'rejected')
 * @returns true if update was successful, false otherwise
 */
export async function updateStagingStatus(
  yelpId: string,
  status: YelpStagingStatus
): Promise<boolean> {
  try {
    // Input validation
    if (!yelpId || typeof yelpId !== 'string' || yelpId.trim().length === 0) {
      console.error('❌ updateStagingStatus: Invalid yelpId provided');
      return false;
    }

    const validStatuses: YelpStagingStatus[] = ['new', 'duplicate', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      console.error(`❌ updateStagingStatus: Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
      return false;
    }

    // Update the status
    const { error, data } = await supabaseServer
      .from('yelp_staging')
      .update({ status })
      .eq('id', yelpId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('❌ Error updating staging status:', {
        yelpId,
        status,
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      return false;
    }

    // Check if record was found and updated
    if (!data) {
      console.warn(`⚠️ updateStagingStatus: Restaurant with ID "${yelpId}" not found in database`);
      return false;
    }

    console.log(`✅ Successfully updated staging status: ${yelpId} → ${status}`);
    return true;
  } catch (error) {
    console.error('❌ Exception updating staging status:', {
      yelpId,
      status,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return false;
  }
}

/**
 * Bulk update the status of multiple staging businesses
 * More efficient than individual updates for large batches
 * 
 * @param yelpIds - Array of Yelp business IDs to update
 * @param status - The new status to set ('new' | 'duplicate' | 'approved' | 'rejected')
 * @returns Object with success count, failed count, and failed IDs
 */
export async function bulkUpdateStagingStatus(
  yelpIds: string[],
  status: YelpStagingStatus
): Promise<{ successCount: number; failedCount: number; failedIds: string[] }> {
  try {
    // Input validation
    if (!yelpIds || !Array.isArray(yelpIds) || yelpIds.length === 0) {
      console.error('❌ bulkUpdateStagingStatus: Invalid yelpIds provided - must be non-empty array');
      return { successCount: 0, failedCount: 0, failedIds: [] };
    }

    const validStatuses: YelpStagingStatus[] = ['new', 'duplicate', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      console.error(`❌ bulkUpdateStagingStatus: Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
      return { successCount: 0, failedCount: yelpIds.length, failedIds: yelpIds };
    }

    // Filter out invalid IDs
    const validIds = yelpIds.filter(id => id && typeof id === 'string' && id.trim().length > 0);
    if (validIds.length === 0) {
      console.error('❌ bulkUpdateStagingStatus: No valid IDs provided after filtering');
      return { successCount: 0, failedCount: yelpIds.length, failedIds: yelpIds };
    }

    // Remove duplicates
    const uniqueIds = Array.from(new Set(validIds.map(id => id.trim())));

    console.log(`📦 bulkUpdateStagingStatus: Updating ${uniqueIds.length} businesses to status "${status}"`);

    // Process in batches to avoid overwhelming the database
    const batchSize = 100;
    let totalSuccessCount = 0;
    const failedIds: string[] = [];

    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batch = uniqueIds.slice(i, i + batchSize);
      console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}: ${batch.length} businesses`);

      // Update batch using Supabase .in() filter
      const { data, error } = await supabaseServer
        .from('yelp_staging')
        .update({ status })
        .in('id', batch)
        .select('id');

      if (error) {
        console.error('❌ Error bulk updating staging status:', {
          batchIndex: i,
          batchSize: batch.length,
          status,
          error: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint
        });
        // Mark entire batch as failed
        failedIds.push(...batch);
      } else {
        // Count successful updates
        const updatedIds = data?.map(record => record.id) || [];
        const successInBatch = updatedIds.length;
        totalSuccessCount += successInBatch;

        // Find failed IDs (IDs that were requested but not updated)
        const updatedSet = new Set(updatedIds);
        const failedInBatch = batch.filter(id => !updatedSet.has(id));
        failedIds.push(...failedInBatch);

        console.log(`    ✅ Successfully updated ${successInBatch} businesses (${failedInBatch.length} not found)`);
      }
    }

    const totalFailed = failedIds.length;
    console.log(`📊 bulkUpdateStagingStatus summary: ${totalSuccessCount} updated, ${totalFailed} failed`);

    return {
      successCount: totalSuccessCount,
      failedCount: totalFailed,
      failedIds
    };
  } catch (error) {
    console.error('❌ Exception in bulkUpdateStagingStatus:', {
      status,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      yelpIdsCount: yelpIds.length
    });
    return {
      successCount: 0,
      failedCount: yelpIds.length,
      failedIds: yelpIds
    };
  }
}

