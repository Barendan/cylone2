'use client';

import { useState, useMemo, useEffect } from 'react';

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
  coverageQuality: string;
  error?: string;
}

interface YelpTestResult {
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
    validationErrors?: number;
    duplicatesSkipped?: number;
    newRestaurantsCount?: number;
  };
}

interface RestaurantReviewPanelProps {
  yelpResults: YelpTestResult | null;
}

export default function RestaurantReviewPanel({ yelpResults }: RestaurantReviewPanelProps) {
  const [expandedDetailsHexagons, setExpandedDetailsHexagons] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'summary' | 'details' | 'restaurants'>('summary');
  
  // Restaurants tab state - simplified
  const [restaurantPage, setRestaurantPage] = useState(1);
  const [restaurantSortOrder, setRestaurantSortOrder] = useState<'asc' | 'desc'>('asc');
  const [restaurantSearch, setRestaurantSearch] = useState<string>('');
  const [restaurantSortType, setRestaurantSortType] = useState<'alphabetical' | 'rating'>('alphabetical');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const restaurantsPerPage = 10;
  
  // Review state - track which restaurants have been approved/rejected
  const [reviewedRestaurantIds, setReviewedRestaurantIds] = useState<Set<string>>(new Set());
  const [reviewedRestaurantStatus, setReviewedRestaurantStatus] = useState<Map<string, 'approved' | 'rejected' | 'duplicate'>>(new Map());
  const [updatingRestaurantIds, setUpdatingRestaurantIds] = useState<Set<string>>(new Set());
  const [reviewMessage, setReviewMessage] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  
  // Bulk selection state
  const [selectedRestaurantIds, setSelectedRestaurantIds] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  
  // Progress tracking for bulk operations
  const [bulkProgress, setBulkProgress] = useState<{
    processed: number;
    total: number;
    isActive: boolean;
  }>({
    processed: 0,
    total: 0,
    isActive: false
  });
  
  // Confirmation dialog state
  const [confirmationDialog, setConfirmationDialog] = useState<{
    isOpen: boolean;
    action: 'approved' | 'rejected' | null;
    count: number;
  }>({
    isOpen: false,
    action: null,
    count: 0
  });
  
  // Details tab state
  const [detailsSortBy, setDetailsSortBy] = useState<'index' | 'restaurants' | 'status'>('index');
  const [detailsSortOrder, setDetailsSortOrder] = useState<'asc' | 'desc'>('asc');
  const [detailsFilterStatus, setDetailsFilterStatus] = useState<string>('all');

  // Restaurant filter state - for filtering franchises and zero-rated restaurants
  const [filterOutFranchises, setFilterOutFranchises] = useState(false);
  const [filterOutZeroRating, setFilterOutZeroRating] = useState(false);
  const [filterOutNoFullAddress, setFilterOutNoFullAddress] = useState(false);
  const [filterOutCached, setFilterOutCached] = useState(false);

  // FIX: Move early return check AFTER all hooks are called
  // All hooks must be called in the same order on every render

  // Helper functions - must be defined before useMemo hooks
  const getAllRestaurants = () => {
    // Use newBusinesses if available (only restaurants added to staging, already deduplicated)
    if (yelpResults?.newBusinesses) {
      return yelpResults.newBusinesses;
    }
    
    // Fallback to old behavior for backward compatibility
    if (!yelpResults?.results) return [];
    const allBusinesses = yelpResults.results.flatMap(result => result.uniqueBusinesses || []);
    
    // Deduplicate by business ID
    const uniqueMap = new Map<string, Restaurant>();
    allBusinesses.forEach(business => {
      if (!uniqueMap.has(business.id)) {
        uniqueMap.set(business.id, business);
      }
    });
    
    // Don't filter out reviewed restaurants - keep them visible
    return Array.from(uniqueMap.values());
  };

  // Create mapping from restaurant ID to hexagon ID
  // This is needed because restaurants can come from multiple hexagons
  const restaurantToHexagonMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!yelpResults?.results) return map;
    
    yelpResults.results.forEach(result => {
      if (result.uniqueBusinesses) {
        result.uniqueBusinesses.forEach(restaurant => {
          // If restaurant appears in multiple hexagons, keep the first one
          if (!map.has(restaurant.id)) {
            map.set(restaurant.id, result.h3Id);
          }
        });
      }
    });
    
    return map;
  }, [yelpResults?.results]);

  // Get restaurant counts
  const getRestaurantCounts = () => {
    // Use new processingStats if available
    if (yelpResults?.processingStats?.restaurantsFetched !== undefined) {
      return { 
        total: yelpResults.processingStats.restaurantsFetched, // Total fetched from Yelp
        unique: yelpResults.newBusinesses?.length || yelpResults.processingStats.newRestaurantsCount || 0 // New restaurants added to staging
      };
    }
    
    // Fallback to old behavior for backward compatibility
    if (!yelpResults?.results) return { total: 0, unique: 0 };
    const allBusinesses = yelpResults.results.flatMap(result => result.uniqueBusinesses || []);
    const total = allBusinesses.length; // Total including duplicates across hexagons
    const unique = getAllRestaurants().length; // After deduplication
    return { total, unique };
  };
  
  // Convert meters to miles
  const metersToMiles = (meters: number): string => {
    const miles = meters / 1609.34;
    return miles.toFixed(1);
  };
  
  // Franchise detection with strict regex and word boundaries
  // This function detects major restaurant chains using precise pattern matching
  // to minimize false positives while catching common franchise variations
  const detectFranchise = (restaurantName: string): boolean => {
    if (!restaurantName) return false;
    
    // Normalize: lowercase, remove apostrophes and special quotes
    const normalized = restaurantName.toLowerCase().replace(/['']/g, '');
    
    // Franchise patterns with word boundaries - covers major chains
    // Each pattern uses \b for word boundaries to avoid false matches
    const franchisePatterns = [
      // Fast Food - Burgers
      /\b(mcdonald'?s?|burger\s+king|wendy'?s?|five\s+guys|in-n-out|shake\s+shack|smashburger|white\s+castle)\b/,
      
      // Fast Food - Sandwiches & Subs
      /\b(subway|jimmy\s+john'?s?|jersey\s+mike'?s?|firehouse\s+subs?|quiznos|potbelly)\b/,
      
      // Fast Food - Chicken
      /\b(chick-fil-a|chickfila|kfc|kentucky\s+fried|popeye'?s?|raising\s+cane'?s?|wingstop|buffalo\s+wild\s+wings?)\b/,
      
      // Fast Food - Mexican
      /\b(taco\s+bell|chipotle|qdoba|del\s+taco|taco\s+cabana|moe'?s?\s+southwest)\b/,
      
      // Fast Food - Pizza
      /\b(pizza\s+hut|domino'?s?|papa\s+john'?s?|little\s+caesars?|marco'?s?\s+pizza|papa\s+murphy'?s?)\b/,
      
      // Fast Food - Other
      /\b(panda\s+express|arby'?s?|sonic\s+drive-in|sonic|dairy\s+queen|culver'?s?|portillo'?s?)\b/,
      
      // Coffee & Breakfast
      /\b(starbucks|dunkin'?(\s+donuts)?|tim\s+hortons?|panera\s+bread|ihop|denny'?s?|waffle\s+house|cracker\s+barrel)\b/,
      
      // Casual Dining
      /\b(applebee'?s?|chili'?s?|olive\s+garden|red\s+lobster|outback\s+steakhouse|texas\s+roadhouse|longhorn\s+steakhouse)\b/,
      
      // Fast Casual & Modern Chains
      /\b(cava|sweetgreen|blaze\s+pizza|mod\s+pizza|&pizza|pieology)\b/,
    ];
    
    // Test against all patterns
    return franchisePatterns.some(pattern => pattern.test(normalized));
  };
  
  // Calculate filter statistics
  // Returns counts for each filter type and overlap
  // NOTE: This function must be defined AFTER detectFranchise since it calls it
  const getFilterStats = () => {
    const allRestaurants = getAllRestaurants();
    const totalCount = allRestaurants.length;
    
    // Count what would be filtered by each filter
    const franchiseCount = allRestaurants.filter(r => detectFranchise(r.name)).length;
    const zeroRatingCount = allRestaurants.filter(r => r.rating === 0).length;
    const noFullAddressCount = allRestaurants.filter(r => !r.location?.address1 || r.location.address1.trim() === '').length;
    
    // Count restaurants from cached hexagons
    let cachedCount = 0;
    if (yelpResults?.results) {
      const cachedHexIds = new Set(
        yelpResults.results
          .filter(r => r.coverageQuality === 'cached')
          .map(r => r.h3Id)
      );
      
      if (cachedHexIds.size > 0) {
        cachedCount = allRestaurants.filter(restaurant => {
          const hexId = restaurantToHexagonMap.get(restaurant.id);
          return hexId ? cachedHexIds.has(hexId) : false;
        }).length;
      }
    }
    
    return {
      total: totalCount,
      franchises: franchiseCount,
      zeroRating: zeroRatingCount,
      noFullAddress: noFullAddressCount,
      cached: cachedCount,
    };
  };
  
  // Handle restaurant approval/rejection
  const handleRestaurantReview = async (restaurantId: string, status: 'approved' | 'rejected') => {
    // Rejection is a no-op - we just track it in UI, don't save to staging
    if (status === 'rejected') {
      setReviewedRestaurantIds(prev => new Set(prev).add(restaurantId));
      setReviewedRestaurantStatus(prev => new Map(prev).set(restaurantId, status));
      setSelectedRestaurantIds(prev => {
        const next = new Set(prev);
        next.delete(restaurantId);
        return next;
      });
      setReviewMessage({ type: 'success', text: 'Restaurant rejected (not saved to staging)' });
      setTimeout(() => setReviewMessage(null), 3000);
      return;
    }

    // For approval, we need to create the staging record
    try {
      setUpdatingRestaurantIds(prev => new Set(prev).add(restaurantId));
      
      // Get restaurant object and its hexagon
      const restaurant = getAllRestaurants().find(r => r.id === restaurantId);
      if (!restaurant) {
        throw new Error('Restaurant not found');
      }

      const h3Id = restaurantToHexagonMap.get(restaurantId);
      if (!h3Id) {
        throw new Error('Could not determine hexagon for restaurant');
      }

      if (!yelpResults?.importLogId || !yelpResults?.cityId) {
        throw new Error('Missing import log ID or city ID. Please run a new search.');
      }

      const response = await fetch('/api/yelp/staging', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'bulk-create',
          restaurants: [restaurant],
          h3Id,
          cityId: yelpResults.cityId,
          importLogId: yelpResults.importLogId,
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok || !data.success) {
        // Check if it's a duplicate
        if (data.duplicates && data.duplicates.length > 0) {
          const duplicateInfo = data.duplicates[0];
          setReviewMessage({ 
            type: 'warning', 
            text: `Restaurant already exists in city ${duplicateInfo.cityId} (Yelp ID: ${duplicateInfo.yelpId})` 
          });
          // Still mark as reviewed so user doesn't try again
          setReviewedRestaurantIds(prev => new Set(prev).add(restaurantId));
          setReviewedRestaurantStatus(prev => new Map(prev).set(restaurantId, 'duplicate'));
          setTimeout(() => setReviewMessage(null), 5000);
        } else {
          throw new Error(data.message || 'Failed to create restaurant in staging');
        }
      } else {
        // Success - check for partial duplicates
        if (data.duplicates && data.duplicates.length > 0) {
          setReviewMessage({ 
            type: 'info', 
            text: `Saved to staging, but restaurant also exists in ${data.duplicates.length} other location${data.duplicates.length === 1 ? '' : 's'}` 
          });
        } else {
          setReviewMessage({ 
            type: 'success', 
            text: `Successfully approved and saved restaurant to staging` 
          });
        }
        setTimeout(() => setReviewMessage(null), 3000);
        
        // Track the review status
        setReviewedRestaurantIds(prev => new Set(prev).add(restaurantId));
        setReviewedRestaurantStatus(prev => new Map(prev).set(restaurantId, status));
      }
      
      // Remove from selection if selected
      setSelectedRestaurantIds(prev => {
        const next = new Set(prev);
        next.delete(restaurantId);
        return next;
      });
      
      // Pagination will reset automatically via useEffect when restaurants change
    } catch (error) {
      console.error('Error approving restaurant:', error);
      setReviewMessage({ 
        type: 'error', 
        text: error instanceof Error ? error.message : 'Failed to approve restaurant' 
      });
      setTimeout(() => setReviewMessage(null), 5000);
    } finally {
      setUpdatingRestaurantIds(prev => {
        const next = new Set(prev);
        next.delete(restaurantId);
        return next;
      });
    }
  };

  // Export selected restaurants to CSV
  const exportSelectedRestaurantsCSV = () => {
    const selectedIds = Array.from(selectedRestaurantIds);
    if (selectedIds.length === 0) {
      setReviewMessage({ 
        type: 'error', 
        text: 'Please select at least one restaurant to export' 
      });
      setTimeout(() => setReviewMessage(null), 3000);
      return;
    }

    const selectedRestaurants = getAllRestaurants().filter(r => selectedIds.includes(r.id));
    
    // CSV header
    const headers = ['Name', 'Rating', 'Price', 'Category', 'Address', 'City', 'State', 'Zip Code', 'Phone', 'Distance (miles)', 'Yelp URL'];
    const rows = selectedRestaurants.map(r => [
      r.name || '',
      r.rating?.toString() || '',
      r.price || '',
      r.categories?.[0]?.title || '',
      r.location?.address1 || '',
      r.location?.city || '',
      r.location?.state || '',
      r.location?.zip_code || '',
      r.phone || '',
      metersToMiles(r.distance || 0),
      r.url || ''
    ]);
    
    // Escape CSV values
    const escapeCsv = (value: string) => {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };
    
    const csvContent = [
      headers.map(escapeCsv).join(','),
      ...rows.map(row => row.map(escapeCsv).join(','))
    ].join('\n');
    
    const dataBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `restaurants_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    setReviewMessage({ 
      type: 'success', 
      text: `Exported ${selectedRestaurants.length} restaurant${selectedRestaurants.length === 1 ? '' : 's'} to CSV` 
    });
    setTimeout(() => setReviewMessage(null), 3000);
  };

  // Handle bulk restaurant approval/rejection (with confirmation for reject)
  const handleBulkRestaurantReview = async (status: 'approved' | 'rejected', skipConfirmation = false) => {
    const selectedIds = Array.from(selectedRestaurantIds);
    if (selectedIds.length === 0) {
      setReviewMessage({ 
        type: 'error', 
        text: 'Please select at least one restaurant' 
      });
      setTimeout(() => setReviewMessage(null), 3000);
      return;
    }

    // Rejection is a no-op - we just track it in UI, don't save to staging
    if (status === 'rejected') {
      if (!skipConfirmation) {
        setConfirmationDialog({
          isOpen: true,
          action: 'rejected',
          count: selectedIds.length
        });
        return;
      }
      
      // Track rejected restaurants
      setReviewedRestaurantIds(prev => {
        const next = new Set(prev);
        selectedIds.forEach(id => next.add(id));
        return next;
      });
      setReviewedRestaurantStatus(prev => {
        const next = new Map(prev);
        selectedIds.forEach(id => next.set(id, status));
        return next;
      });
      setSelectedRestaurantIds(new Set());
      setReviewMessage({ type: 'success', text: `Rejected ${selectedIds.length} restaurant${selectedIds.length === 1 ? '' : 's'} (not saved to staging)` });
      setTimeout(() => setReviewMessage(null), 4000);
      if (confirmationDialog.isOpen) {
        setConfirmationDialog({ isOpen: false, action: null, count: 0 });
      }
      return;
    }

    // For approval, we need to create staging records
    try {
      setIsBulkUpdating(true);
      setBulkProgress({
        processed: 0,
        total: selectedIds.length,
        isActive: true
      });
      
      setUpdatingRestaurantIds(prev => {
        const next = new Set(prev);
        selectedIds.forEach(id => next.add(id));
        return next;
      });

      if (!yelpResults?.importLogId || !yelpResults?.cityId) {
        throw new Error('Missing import log ID or city ID. Please run a new search.');
      }

      // Get all selected restaurants
      const allRestaurants = getAllRestaurants();
      const selectedRestaurants = allRestaurants.filter(r => selectedIds.includes(r.id));
      
      // Group restaurants by hexagon (h3Id)
      const restaurantsByHexagon = new Map<string, Restaurant[]>();
      selectedRestaurants.forEach(restaurant => {
        const h3Id = restaurantToHexagonMap.get(restaurant.id);
        if (h3Id) {
          if (!restaurantsByHexagon.has(h3Id)) {
            restaurantsByHexagon.set(h3Id, []);
          }
          restaurantsByHexagon.get(h3Id)!.push(restaurant);
        }
      });

      // Create staging records for each hexagon group
      let totalCreated = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      const errors: string[] = [];

      for (const [h3Id, restaurants] of restaurantsByHexagon.entries()) {
        try {
          const response = await fetch('/api/yelp/staging', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'bulk-create',
              restaurants,
              h3Id,
              cityId: yelpResults.cityId,
              importLogId: yelpResults.importLogId,
            }),
          });
          
          const data = await response.json();
          
          if (response.ok && data.success) {
            totalCreated += data.createdCount || 0;
            totalSkipped += data.skippedCount || 0;
            totalErrors += data.errorCount || 0;
            
            // Update progress
            setBulkProgress({
              processed: totalCreated,
              total: selectedIds.length,
              isActive: true
            });
          } else {
            totalErrors += restaurants.length;
            errors.push(`Failed to save ${restaurants.length} restaurants from hexagon ${h3Id}: ${data.message || 'Unknown error'}`);
          }
        } catch (error) {
          totalErrors += restaurants.length;
          errors.push(`Error saving ${restaurants.length} restaurants from hexagon ${h3Id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      // Track reviewed restaurants and their status
      setReviewedRestaurantIds(prev => {
        const next = new Set(prev);
        selectedIds.forEach(id => next.add(id));
        return next;
      });
      setReviewedRestaurantStatus(prev => {
        const next = new Map(prev);
        selectedIds.forEach(id => next.set(id, status));
        return next;
      });
      
      // Clear selection and localStorage
      setSelectedRestaurantIds(new Set());
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem('restaurantSelections');
        } catch (error) {
          console.warn('Failed to clear selections from localStorage:', error);
        }
      }
      
      // Show success/error message
      if (totalCreated > 0 && errors.length === 0) {
        setReviewMessage({ 
          type: 'success', 
          text: `Successfully approved and saved ${totalCreated} restaurant${totalCreated === 1 ? '' : 's'} to staging${totalSkipped > 0 ? ` (${totalSkipped} duplicates skipped)` : ''}` 
        });
      } else if (totalCreated > 0) {
        setReviewMessage({ 
          type: 'error', 
          text: `Partially completed: ${totalCreated} saved, ${totalErrors} failed. ${errors.slice(0, 2).join('; ')}` 
        });
      } else {
        throw new Error(`Failed to save any restaurants. ${errors.join('; ')}`);
      }
      setTimeout(() => setReviewMessage(null), 6000);
      
      // Reset to first page if needed
      if (restaurantPage > 1 && processedRestaurants.length <= selectedIds.length) {
        setRestaurantPage(1);
      }
    } catch (error) {
      console.error('Error bulk approving restaurants:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to bulk approve restaurants';
      setReviewMessage({ 
        type: 'error', 
        text: `${errorMessage}. Please try again or select fewer restaurants.` 
      });
      setTimeout(() => setReviewMessage(null), 6000);
    } finally {
      setIsBulkUpdating(false);
      setBulkProgress({
        processed: 0,
        total: 0,
        isActive: false
      });
      
      setUpdatingRestaurantIds(prev => {
        const next = new Set(prev);
        selectedIds.forEach(id => next.delete(id));
        return next;
      });
      // Close confirmation dialog if open
      if (confirmationDialog.isOpen) {
        setConfirmationDialog({ isOpen: false, action: null, count: 0 });
      }
    }
  };

  // Confirm bulk reject action
  const confirmBulkReject = () => {
    if (confirmationDialog.action === 'rejected') {
      handleBulkRestaurantReview('rejected', true);
    }
  };

  // Cancel bulk reject action
  const cancelBulkReject = () => {
    setConfirmationDialog({ isOpen: false, action: null, count: 0 });
  };

  // Toggle restaurant selection
  const toggleRestaurantSelection = (restaurantId: string) => {
    setSelectedRestaurantIds(prev => {
      const next = new Set(prev);
      if (next.has(restaurantId)) {
        next.delete(restaurantId);
      } else {
        next.add(restaurantId);
      }
      return next;
    });
  };

  // Deselect all restaurants
  const deselectAll = () => {
    setSelectedRestaurantIds(new Set());
  };

  // Filtered and sorted restaurants for restaurants tab - simplified
  const processedRestaurants = useMemo(() => {
    let restaurants = getAllRestaurants();
    
    // Apply franchise filter FIRST (before search)
    if (filterOutFranchises) {
      restaurants = restaurants.filter(r => !detectFranchise(r.name));
    }
    
    // Apply zero-rating filter SECOND (before search)
    if (filterOutZeroRating) {
      restaurants = restaurants.filter(r => r.rating > 0);
    }
    
    // Apply no-full-address filter THIRD (before search)
    if (filterOutNoFullAddress) {
      restaurants = restaurants.filter(r => r.location?.address1 && r.location.address1.trim() !== '');
    }
    
    // Apply cached filter FOURTH (before search)
    // Filter out restaurants from cached hexagons
    if (filterOutCached && yelpResults?.results) {
      // Get all cached hexagon IDs
      const cachedHexIds = new Set(
        yelpResults.results
          .filter(r => r.coverageQuality === 'cached')
          .map(r => r.h3Id)
      );
      
      // Filter out restaurants from those hexagons
      if (cachedHexIds.size > 0) {
        restaurants = restaurants.filter(restaurant => {
          const hexId = restaurantToHexagonMap.get(restaurant.id);
          return hexId ? !cachedHexIds.has(hexId) : true;
        });
      }
    }
    
    // Apply search filter
    if (restaurantSearch) {
      const searchLower = restaurantSearch.toLowerCase();
      restaurants = restaurants.filter(r => 
        (r.name && r.name.toLowerCase().includes(searchLower)) ||
        (r.categories && r.categories.some(cat => cat.title && cat.title.toLowerCase().includes(searchLower))) ||
        (r.location && r.location.city && r.location.city.toLowerCase().includes(searchLower))
      );
    }
    
    // Apply sorting based on sort type - create a new array to avoid mutation
    const sorted = [...restaurants].sort((a, b) => {
      let comparison = 0;
      
      if (restaurantSortType === 'alphabetical') {
        const nameA = a.name || '';
        const nameB = b.name || '';
        comparison = nameA.localeCompare(nameB);
      } else if (restaurantSortType === 'rating') {
        // Sort by rating (higher first for desc, lower first for asc)
        comparison = a.rating - b.rating;
      }
      
      return restaurantSortOrder === 'asc' ? comparison : -comparison;
    });
    
    return sorted;
  }, [restaurantSearch, restaurantSortOrder, restaurantSortType, yelpResults, reviewedRestaurantIds, filterOutFranchises, filterOutZeroRating, filterOutNoFullAddress, filterOutCached, restaurantToHexagonMap]);

  // Paginated restaurants
  const paginatedRestaurants = useMemo(() => {
    const start = (restaurantPage - 1) * restaurantsPerPage;
    return processedRestaurants.slice(start, start + restaurantsPerPage);
  }, [processedRestaurants, restaurantPage]);

  const totalRestaurantPages = Math.ceil(processedRestaurants.length / restaurantsPerPage);

  // Check if all on page are selected (must be after paginatedRestaurants is defined)
  const allOnPageSelected = paginatedRestaurants.length > 0 && 
    paginatedRestaurants.every(r => selectedRestaurantIds.has(r.id));

  // Check if all restaurants across all pages are selected
  const allSelected = processedRestaurants.length > 0 && 
    processedRestaurants.every(r => selectedRestaurantIds.has(r.id));

  // Calculate selection statistics
  const selectionStats = useMemo(() => {
    const totalSelected = selectedRestaurantIds.size;
    const visibleSelected = processedRestaurants.filter(r => selectedRestaurantIds.has(r.id)).length;
    const totalVisible = processedRestaurants.length;
    const hasSearchOrFilter = restaurantSearch.length > 0;
    
    return {
      totalSelected,
      visibleSelected,
      totalVisible,
      hasSearchOrFilter,
      hasHiddenSelections: totalSelected > visibleSelected && hasSearchOrFilter
    };
  }, [selectedRestaurantIds, processedRestaurants, restaurantSearch]);

  // Select all restaurants on current page (must be after paginatedRestaurants is defined)
  const selectAllOnPage = () => {
    const pageIds = paginatedRestaurants.map(r => r.id);
    setSelectedRestaurantIds(prev => {
      const next = new Set(prev);
      pageIds.forEach(id => next.add(id));
      return next;
    });
  };

  // Select all restaurants across all pages (must be after processedRestaurants is defined)
  const selectAll = () => {
    const allIds = processedRestaurants.map(r => r.id);
    setSelectedRestaurantIds(new Set(allIds));
  };

  // Select all visible restaurants (respects current search/filter)
  const selectAllVisible = () => {
    const visibleIds = processedRestaurants.map(r => r.id);
    setSelectedRestaurantIds(prev => {
      const next = new Set(prev);
      visibleIds.forEach(id => next.add(id));
      return next;
    });
  };

  // Check if all visible restaurants are selected
  const allVisibleSelected = processedRestaurants.length > 0 && 
    processedRestaurants.every(r => selectedRestaurantIds.has(r.id));

  // Filtered and sorted hexagons for details tab
  const processedHexagons = useMemo(() => {
    if (!yelpResults?.results) return [];
    let hexagons = [...yelpResults.results];
    
    // Apply status filter
    if (detailsFilterStatus !== 'all') {
      hexagons = hexagons.filter(h => h.status === detailsFilterStatus);
    }
    
    // Apply sorting
    hexagons.sort((a, b) => {
      let comparison = 0;
      switch (detailsSortBy) {
        case 'index':
          comparison = (a.mapIndex ?? 9999) - (b.mapIndex ?? 9999);
          break;
        case 'restaurants':
          comparison = a.totalBusinesses - b.totalBusinesses;
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
      }
      return detailsSortOrder === 'asc' ? comparison : -comparison;
    });
    
    return hexagons;
  }, [yelpResults, detailsSortBy, detailsSortOrder, detailsFilterStatus]);

  // Coverage quality breakdown for summary tab
  const coverageQualityBreakdown = useMemo(() => {
    if (!yelpResults?.results) return {};
    const breakdown: Record<string, number> = {};
    yelpResults.results.forEach(result => {
      const quality = result.coverageQuality || 'unknown';
      breakdown[quality] = (breakdown[quality] || 0) + 1;
    });
    return breakdown;
  }, [yelpResults]);

  // Status breakdown for summary tab
  const statusBreakdown = useMemo(() => {
    if (!yelpResults?.results) return {};
    const breakdown: Record<string, number> = {};
    yelpResults.results.forEach(result => {
      breakdown[result.status] = (breakdown[result.status] || 0) + 1;
    });
    return breakdown;
  }, [yelpResults]);

  const toggleDetailsHexagonExpansion = (h3Id: string) => {
    const newExpanded = new Set(expandedDetailsHexagons);
    if (newExpanded.has(h3Id)) {
      newExpanded.delete(h3Id);
    } else {
      newExpanded.add(h3Id);
    }
    setExpandedDetailsHexagons(newExpanded);
  };

  // Reset pagination when search, sort, or sort type changes
  useEffect(() => {
    setRestaurantPage(1);
  }, [restaurantSearch, restaurantSortOrder, restaurantSortType]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-filter-dropdown]')) {
        setShowFilterDropdown(false);
      }
    };
    
    if (showFilterDropdown) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showFilterDropdown]);

  // Phase 4: Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when restaurants tab is active
      if (activeTab !== 'restaurants') return;
      
      // Don't trigger shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Ctrl+A / Cmd+A: Select all visible restaurants
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const visibleIds = processedRestaurants.map(r => r.id);
        setSelectedRestaurantIds(prev => {
          const next = new Set(prev);
          visibleIds.forEach(id => next.add(id));
          return next;
        });
        return;
      }

      // Escape: Deselect all or close confirmation dialog
      if (e.key === 'Escape') {
        if (confirmationDialog.isOpen) {
          setConfirmationDialog({ isOpen: false, action: null, count: 0 });
        } else if (selectedRestaurantIds.size > 0) {
          setSelectedRestaurantIds(new Set());
        }
        return;
      }

      // Enter: Confirm dialog when open (triggers button click)
      if (e.key === 'Enter' && confirmationDialog.isOpen && !isBulkUpdating) {
        e.preventDefault();
        // Find and click the confirm button
        const confirmButton = document.querySelector('[data-confirm-bulk-reject]') as HTMLButtonElement;
        if (confirmButton && !confirmButton.disabled) {
          confirmButton.click();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeTab, processedRestaurants, confirmationDialog, isBulkUpdating, selectedRestaurantIds.size]);

  // Phase 6: Selection persistence with localStorage
  useEffect(() => {
    // Load selections from localStorage on mount
    if (typeof window !== 'undefined' && yelpResults?.results) {
      try {
        const saved = localStorage.getItem('restaurantSelections');
        if (saved) {
          const savedIds = JSON.parse(saved) as string[];
          // Only restore if we have matching restaurants
          const validIds = savedIds.filter(id => 
            getAllRestaurants().some(r => r.id === id)
          );
          if (validIds.length > 0) {
            setSelectedRestaurantIds(new Set(validIds));
          }
        }
      } catch (error) {
        console.warn('Failed to load selections from localStorage:', error);
      }
    }
  }, [yelpResults?.results]); // Only run when yelpResults changes

  // Save selections to localStorage whenever they change
  useEffect(() => {
    if (typeof window !== 'undefined' && selectedRestaurantIds.size > 0) {
      try {
        localStorage.setItem('restaurantSelections', JSON.stringify(Array.from(selectedRestaurantIds)));
      } catch (error) {
        console.warn('Failed to save selections to localStorage:', error);
      }
    } else if (typeof window !== 'undefined' && selectedRestaurantIds.size === 0) {
      // Clear localStorage when no selections
      try {
        localStorage.removeItem('restaurantSelections');
      } catch (error) {
        console.warn('Failed to clear selections from localStorage:', error);
      }
    }
  }, [selectedRestaurantIds]);

  // Reset reviewed restaurants when new search is run (yelpResults changes)
  useEffect(() => {
    setReviewedRestaurantIds(new Set());
    setReviewedRestaurantStatus(new Map());
    setSelectedRestaurantIds(new Set());
  }, [yelpResults]);

  // FIX: Early return check moved AFTER all hooks (useState, useMemo, useEffect)
  // This ensures hooks are always called in the same order
  if (!yelpResults || !yelpResults.results || yelpResults.results.length === 0) {
    return (
      <div className="mt-8 p-6 bg-gray-50 rounded-lg border border-gray-200 text-center">
        <p className="text-gray-600">No hexagon data available. Run a Yelp integration test to see results.</p>
      </div>
    );
  }

  const getDeduplicationStats = () => {
    // Use new processingStats if available
    if (yelpResults?.processingStats?.restaurantsFetched !== undefined) {
      const total = yelpResults.processingStats.restaurantsFetched || 0;
      const unique = yelpResults.newBusinesses?.length || yelpResults.processingStats.newRestaurantsCount || 0;
      const duplicates = (yelpResults.processingStats.duplicatesSkipped || 0) + (yelpResults.processingStats.validationErrors || 0);
      
      return { total, unique, duplicates };
    }
    
    // Fallback to old behavior for backward compatibility
    if (!yelpResults?.results) return { total: 0, unique: 0, duplicates: 0 };
    
    const allBusinesses = yelpResults.results.flatMap(result => result.uniqueBusinesses || []);
    const uniqueBusinesses = getAllRestaurants();
    
    return {
      total: allBusinesses.length,
      unique: uniqueBusinesses.length,
      duplicates: allBusinesses.length - uniqueBusinesses.length
    };
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'fetched': return 'text-green-600 bg-green-100';
      case 'failed': return 'text-red-600 bg-red-100';
      case 'dense': return 'text-yellow-600 bg-yellow-100';
      case 'split': return 'text-blue-600 bg-blue-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'fetched': return '✅';
      case 'failed': return '❌';
      case 'dense': return '🔀';
      case 'split': return '📊';
      default: return '❓';
    }
  };

  return (
    <div className="mt-6">
      {/* Tabbed Interface */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        {/* Header */}
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-xl font-semibold text-gray-900">Restaurant Data Analysis</h2>
          <p className="text-sm text-gray-600 mt-1">View and analyze restaurant data from processed hexagons</p>
        </div>
        
        {/* Tab Navigation */}
        <div className="flex space-x-1 px-6 pt-4 bg-gray-50 border-b border-gray-200">
          {(['summary', 'details', 'restaurants'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium transition-all duration-200 border-b-2 ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600 bg-white'
                  : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
              }`}
            >
              {tab === 'summary' && '📊 Summary'}
              {tab === 'details' && '🔍 Details'}
              {tab === 'restaurants' && 'Restaurants'}
            </button>
          ))}
        </div>

        {/* Confirmation Dialog */}
        {confirmationDialog.isOpen && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" style={{ zIndex: 9999 }}>
            <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 border-2 border-red-200" style={{ zIndex: 10000 }}>
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-16 h-16 mb-4 bg-red-100 rounded-full">
                  <span className="text-3xl">⚠️</span>
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">
                  Confirm Bulk Reject
                </h3>
                <p className="text-gray-600 text-sm">
                  You are about to reject <span className="font-bold text-red-600">{confirmationDialog.count}</span> restaurant{confirmationDialog.count === 1 ? '' : 's'}.
                </p>
                <p className="text-gray-600 text-sm mt-2">
                  This action cannot be undone. Are you sure?
                </p>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={cancelBulkReject}
                  className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBulkReject}
                  disabled={isBulkUpdating}
                  data-confirm-bulk-reject
                  className="flex-1 px-4 py-2.5 bg-gradient-to-r from-red-500 to-rose-600 text-white font-semibold rounded-lg hover:from-red-600 hover:to-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {isBulkUpdating ? 'Processing...' : 'Confirm Reject (Enter)'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab Content */}
        <div className="p-6 min-h-48">
          {activeTab === 'summary' && (
            <div className="space-y-6">
              {/* Cache Indicator Banner - Shows when data is loaded from cache */}
              {yelpResults.fromCache && (
                <div className="relative overflow-hidden bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl p-4 shadow-lg">
                  <div className="absolute inset-0 bg-white/10 backdrop-blur-sm"></div>
                  <div className="relative z-10 flex items-center gap-3">
                    <div className="text-3xl">💾</div>
                    <div className="text-sm text-white leading-relaxed">
                      <span className="font-bold">Cached Data</span> • Loaded from database • 
                      {yelpResults.processedAt && (
                        <span> Last processed: {new Date(yelpResults.processedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
              
              {/* Modern Dashboard Stats */}
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 p-6 shadow-2xl">
                {/* Decorative background elements */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500 rounded-full blur-3xl opacity-10"></div>
                <div className="absolute bottom-0 left-0 w-64 h-64 bg-emerald-500 rounded-full blur-3xl opacity-10"></div>
                
                <div className="relative z-10">
                  <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <span className="text-blue-400">●</span> System Overview
                  </h3>
                  
                  {/* Primary Stats Row */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    {/* Hexagons Card */}
                    <div className="bg-white/5 backdrop-blur-xl rounded-xl p-4 border border-white/10 hover:border-white/20 transition-all">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-blue-300 uppercase tracking-wider mb-1">Coverage</div>
                          <div className="text-4xl font-black text-white">{yelpResults.results?.length || 0}</div>
                          <div className="text-sm text-gray-400 mt-1">Hexagons Processed</div>
                        </div>
                        <div className="text-5xl opacity-20">🗺️</div>
                      </div>
                    </div>
                    
                    {/* Restaurants Card - Featured */}
                    <div className="bg-gradient-to-br from-emerald-500/20 to-green-500/20 backdrop-blur-xl rounded-xl p-4 border-2 border-emerald-400/30 hover:border-emerald-400/50 transition-all">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-emerald-300 uppercase tracking-wider mb-1">Restaurants Found</div>
                          <div className="text-5xl font-black text-white">{getRestaurantCounts().unique}</div>
                          <div className="text-sm text-emerald-200 font-semibold mt-1">
                            {yelpResults.fromCache ? 'Total Cached' : 'Unique in This Search'}
                          </div>
                          <div className="flex gap-3 mt-2 text-xs">
                            <span className="text-gray-300">{getRestaurantCounts().total} total found</span>
                          </div>
                        </div>
                        <div className="text-6xl opacity-30">✨</div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Secondary Stats Row - Only show for fresh searches, not cached data */}
                  {!yelpResults.fromCache && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/5 backdrop-blur-xl rounded-lg p-3 border border-white/10">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl">❌</div>
                          <div>
                            <div className="text-2xl font-bold text-red-400">{yelpResults.processingStats?.validationErrors || 0}</div>
                            <div className="text-xs text-gray-400">Invalidated</div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="bg-white/5 backdrop-blur-xl rounded-lg p-3 border border-white/10">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl">🔄</div>
                          <div>
                            <div className="text-2xl font-bold text-orange-400">{yelpResults.processingStats?.duplicatesSkipped || 0}</div>
                            <div className="text-xs text-gray-400">DB Duplicates</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Deduplication Statistics */}
              {getDeduplicationStats().duplicates > 0 && (
                <div className="relative overflow-hidden bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl p-4 shadow-lg">
                  <div className="absolute inset-0 bg-white/10 backdrop-blur-sm"></div>
                  <div className="relative z-10 flex items-center gap-3">
                    <div className="text-3xl">📊</div>
                    <div className="text-sm text-white leading-relaxed">
                      <span className="font-bold">Processing Summary:</span> Found <span className="font-semibold">{getDeduplicationStats().total}</span> restaurants from Yelp, 
                      removed <span className="font-semibold">{getDeduplicationStats().duplicates}</span> hexagon overlaps
                      {' → '}<span className="font-black text-yellow-200 text-base">{getDeduplicationStats().unique} UNIQUE</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Analytics Dashboard */}
              <div className="grid md:grid-cols-2 gap-6">
                {/* Status Breakdown Chart */}
                {Object.keys(statusBreakdown).length > 0 && (
                  <div className="bg-gradient-to-br from-slate-50 to-blue-50 rounded-xl p-5 border border-slate-200 shadow-lg">
                    <h4 className="text-sm font-bold text-slate-800 mb-4 flex items-center gap-2">
                      <span className="text-blue-500">▸</span> Hexagon Processing Status
                    </h4>
                    <div className="space-y-3">
                      {Object.entries(statusBreakdown).map(([status, count]) => {
                        const total = yelpResults.results?.length || 1;
                        const percentage = (count / total) * 100;
                        const statusColors: Record<string, { bg: string; text: string }> = {
                          'fetched': { bg: 'bg-green-500', text: 'text-green-600' },
                          'failed': { bg: 'bg-red-500', text: 'text-red-600' },
                          'dense': { bg: 'bg-yellow-500', text: 'text-yellow-600' },
                          'split': { bg: 'bg-blue-500', text: 'text-blue-600' }
                        };
                        return (
                          <div key={status} className="bg-white/60 backdrop-blur-sm rounded-lg p-3 border border-white/50">
                            <div className="flex justify-between items-center text-xs mb-2">
                              <span className={`font-bold capitalize flex items-center gap-1 ${statusColors[status]?.text || 'text-gray-600'}`}>
                                {getStatusIcon(status)} {status}
                              </span>
                              <span className="font-semibold text-slate-700">{count} <span className="text-slate-500">({Math.round(percentage)}%)</span></span>
                            </div>
                            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                              <div 
                                className={`h-2 rounded-full transition-all duration-700 ${statusColors[status]?.bg || 'bg-gray-400'} shadow-sm`}
                                style={{ width: `${percentage}%` }}
                              ></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Coverage Quality Breakdown */}
                {Object.keys(coverageQualityBreakdown).length > 0 && (
                  <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl p-5 border border-purple-200 shadow-lg">
                    <div className="mb-4">
                      <h4 className="text-sm font-bold text-slate-800 mb-1 flex items-center gap-2">
                        <span className="text-purple-500">▸</span> Coverage Quality Analysis
                      </h4>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        Shows how thoroughly each hexagon was scanned. Higher quality means more search points and comprehensive coverage of the area.
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {Object.entries(coverageQualityBreakdown).map(([quality, count]) => {
                        const qualityColors: Record<string, string> = {
                          'excellent': 'from-green-400 to-emerald-500',
                          'good': 'from-blue-400 to-cyan-500',
                          'fair': 'from-yellow-400 to-orange-500',
                          'poor': 'from-red-400 to-rose-500',
                          'cached': 'from-gray-400 to-slate-500',
                        };
                        const gradient = qualityColors[quality] || qualityColors[quality.toLowerCase()] || 'from-gray-400 to-gray-500';
                        
                        return (
                          <div key={quality} className={`bg-gradient-to-br ${gradient} p-4 rounded-xl shadow-md text-center transform hover:scale-105 transition-transform`}>
                            <div className="text-3xl font-black text-white drop-shadow-lg">{count}</div>
                            <div className="text-xs text-white/90 font-semibold capitalize mt-1">{quality.replace(/-/g, ' ')}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'details' && (
            <div className="space-y-4">
              {/* Controls */}
              <div className="flex flex-wrap gap-3 items-center p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-xs text-gray-600 w-full sm:w-auto">
                  Showing {processedHexagons.length} of {yelpResults.results.length} hexagons
                </div>
                <div className="flex items-center space-x-2">
                  <label className="text-xs font-medium text-gray-700">Sort by:</label>
                  <select
                    value={detailsSortBy}
                    onChange={(e) => {
                      setDetailsSortBy(e.target.value as 'index' | 'restaurants' | 'status');
                    }}
                    className="text-sm border-2 border-gray-400 rounded-lg px-3 py-2 bg-white text-gray-900 font-medium hover:border-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
                  >
                    <option value="index">Hexagon Index</option>
                    <option value="restaurants">Restaurant Count</option>
                    <option value="status">Status</option>
                  </select>
                </div>
                <div className="flex items-center space-x-2">
                  <label className="text-xs font-medium text-gray-700">Order:</label>
                  <button
                    onClick={() => setDetailsSortOrder(detailsSortOrder === 'asc' ? 'desc' : 'asc')}
                    className="text-sm font-medium border-2 border-gray-400 rounded-lg px-3 py-2 bg-white text-gray-900 hover:bg-gray-100 hover:border-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors shadow-sm"
                  >
                    {detailsSortOrder === 'asc' ? '↑ Asc' : '↓ Desc'}
                  </button>
                </div>
                <div className="flex items-center space-x-2">
                  <label className="text-xs font-medium text-gray-700">Filter:</label>
                  <select
                    value={detailsFilterStatus}
                    onChange={(e) => {
                      setDetailsFilterStatus(e.target.value);
                    }}
                    className="text-sm border-2 border-gray-400 rounded-lg px-3 py-2 bg-white text-gray-900 font-medium hover:border-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
                  >
                    <option value="all">All Status</option>
                    <option value="fetched">✅ Fetched</option>
                    <option value="failed">❌ Failed</option>
                    <option value="dense">🔀 Dense</option>
                    <option value="split">📊 Split</option>
                  </select>
                </div>
              </div>

              {/* Hexagon List */}
              <div className="space-y-2">
                {processedHexagons.map((result) => (
                  <div key={result.h3Id} className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
                    <button
                      onClick={() => toggleDetailsHexagonExpansion(result.h3Id)}
                      className="w-full flex items-center justify-between p-3 hover:bg-gray-100 transition-colors"
                    >
                  <div className="flex items-center space-x-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(result.status)}`}>
                      {getStatusIcon(result.status)} {result.status}
                    </span>
                    <span className="font-mono text-sm text-gray-600 bg-blue-100 px-2 py-1 rounded">
                      🔢 Hexagon {result.mapIndex !== undefined ? result.mapIndex : '?'}
                    </span>
                  </div>
                      <div className="flex items-center space-x-4">
                  <div className="text-right">
                    <div className="font-medium text-gray-800">{result.totalBusinesses} restaurants</div>
                    <div className="text-sm text-gray-600">{result.coverageQuality} coverage</div>
                  </div>
                        <span className="text-gray-400 text-lg">
                          {expandedDetailsHexagons.has(result.h3Id) ? '▼' : '▶'}
                        </span>
                      </div>
                    </button>
                    
                    {/* Expanded Restaurant List */}
                    {expandedDetailsHexagons.has(result.h3Id) && (
                      <div className="border-t border-gray-200 p-4 bg-white">
                        {result.uniqueBusinesses && result.uniqueBusinesses.length > 0 ? (
                          <div className="space-y-2 max-h-96 overflow-y-auto">
                            {result.uniqueBusinesses.map((restaurant, idx) => (
                              <div key={restaurant.id || idx} className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="font-semibold text-gray-800 text-sm">{restaurant.name}</div>
                                    <div className="flex items-center space-x-2 mt-1 text-xs">
                                      <span className="text-yellow-600">⭐ {restaurant.rating}</span>
                                      {restaurant.price && <span className="text-green-600 font-medium">{restaurant.price}</span>}
                                      {restaurant.categories?.[0]?.title && (
                                        <span className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                                          {restaurant.categories[0].title}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-xs text-gray-600 mt-1">
                                      📍 {restaurant.location.address1}, {restaurant.location.city}
                                    </div>
                                  </div>
                                  <div className="text-right text-xs text-gray-600 ml-3">
                                    <div className="text-purple-600 font-medium">{metersToMiles(restaurant.distance)} mi</div>
                                    <a 
                                      href={restaurant.url} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:underline mt-1 block"
                                    >
                                      View on Yelp
                                    </a>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-gray-500 text-sm text-center py-4">No restaurants found in this hexagon</div>
                        )}
                      </div>
                    )}
                </div>
              ))}
              </div>
            </div>
          )}

          {activeTab === 'restaurants' && (
            <div className="space-y-3">
              {/* Review message */}
              {reviewMessage && (
                <div className={`p-4 rounded-xl shadow-lg animate-pulse ${
                  reviewMessage.type === 'success' 
                    ? 'bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300 text-green-800' 
                    : reviewMessage.type === 'error'
                    ? 'bg-gradient-to-r from-red-50 to-rose-50 border-2 border-red-300 text-red-800'
                    : reviewMessage.type === 'warning'
                    ? 'bg-gradient-to-r from-yellow-50 to-amber-50 border-2 border-yellow-300 text-yellow-800'
                    : 'bg-gradient-to-r from-blue-50 to-cyan-50 border-2 border-blue-300 text-blue-800'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xl">
                      {reviewMessage.type === 'success' ? '✓' : reviewMessage.type === 'error' ? '✗' : reviewMessage.type === 'warning' ? '⚠️' : 'ℹ️'}
                    </span>
                    <span className="font-semibold">{reviewMessage.text}</span>
                  </div>
                </div>
              )}
              
              {/* Phase 5: Progress Indicator */}
              {bulkProgress.isActive && bulkProgress.total > 0 && (
                <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border-2 border-blue-200 shadow-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-gray-700">
                      Processing bulk operation...
                    </span>
                    <span className="text-sm font-bold text-blue-600">
                      {bulkProgress.processed} / {bulkProgress.total}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div 
                      className="bg-gradient-to-r from-blue-500 to-indigo-600 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min((bulkProgress.processed / bulkProgress.total) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Cache Indicator Banner - Restaurants Tab */}
              {yelpResults.fromCache && (
                <div className="relative overflow-hidden bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl p-3 shadow-lg mb-3">
                  <div className="absolute inset-0 bg-white/10 backdrop-blur-sm"></div>
                  <div className="relative z-10 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="text-2xl">💾</div>
                      <div className="text-sm text-white leading-relaxed">
                        <span className="font-bold">Cached Data</span> • These restaurants were previously fetched
                        {yelpResults.processedAt && (
                          <span> • Last processed: {new Date(yelpResults.processedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-white/90 bg-white/20 px-3 py-1 rounded-full font-semibold">
                      ⓘ Approving will check for duplicates
                    </div>
                  </div>
                </div>
              )}

              {/* Unified Control Panel - Compact Modern Design */}
              <div className="bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
                {/* Section 1: Restaurant Directory Header */}
                <div className="bg-gradient-to-r from-purple-500 via-pink-500 to-orange-500 px-5 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <h4 className="text-lg font-bold text-white tracking-tight">
                        Restaurant Directory
                      </h4>
                      <p className="text-white/90 text-xs font-medium">Discover amazing places to eat!</p>
                    </div>
                    <div className="bg-white/20 backdrop-blur-lg rounded-xl px-5 py-2 border border-white/40 shadow-lg">
                      <div className="text-2xl font-black text-white tracking-tight">{processedRestaurants.length}</div>
                      <div className="text-[10px] text-white/95 font-semibold uppercase tracking-wide">
                        {processedRestaurants.length === getAllRestaurants().length ? 'Total' : 'Found'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Filter Statistics Banner - Shows when filters are active */}
                {(filterOutFranchises || filterOutZeroRating || filterOutNoFullAddress || filterOutCached) && (() => {
                  const stats = getFilterStats();
                  const filteredOutCount = stats.total - processedRestaurants.length;
                  
                  return (
                    <div className="bg-gradient-to-r from-orange-50 to-amber-50 px-4 py-2.5 border-b border-orange-200">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="text-orange-600 text-lg">🔍</span>
                          <div className="text-xs">
                            <span className="font-bold text-orange-800">
                              {filteredOutCount} restaurant{filteredOutCount !== 1 ? 's' : ''} hidden
                            </span>
                            <span className="text-orange-600 ml-1">by active filters</span>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2 text-[10px]">
                          {filterOutFranchises && (
                            <span className="bg-red-100 text-red-700 px-2 py-1 rounded-full font-semibold">
                              🚫 {stats.franchises} chains
                            </span>
                          )}
                          {filterOutZeroRating && (
                            <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full font-semibold">
                              ⭐ {stats.zeroRating} unrated
                            </span>
                          )}
                          {filterOutNoFullAddress && (
                            <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded-full font-semibold">
                              📍 {stats.noFullAddress} no address
                            </span>
                          )}
                          {filterOutCached && (
                            <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded-full font-semibold">
                              💾 {stats.cached} cached
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Section 2: Search & Filter Controls */}
                <div className="bg-gradient-to-br from-slate-50 to-blue-50 px-4 py-3 border-b border-gray-200">
                  <div className="flex flex-col sm:flex-row gap-2">
                    {/* Search Input */}
                    <div className="flex-1 relative group">
                      <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 text-sm transition-colors group-hover:text-blue-500">
                        🔍
                      </div>
                      <input
                        type="text"
                        placeholder="Search restaurants by name, category, or city..."
                        value={restaurantSearch}
                        onChange={(e) => {
                          setRestaurantSearch(e.target.value);
                          setRestaurantPage(1);
                        }}
                        className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-500 text-sm text-gray-900 bg-white font-medium placeholder:text-gray-400 shadow-sm transition-all hover:border-blue-400"
                      />
                    </div>
                    
                    {/* Filter & Sort Buttons Group */}
                    <div className="flex gap-2">
                      {/* Franchise Filter Button */}
                      <button
                        onClick={() => {
                          setFilterOutFranchises(!filterOutFranchises);
                          setRestaurantPage(1); // Reset pagination
                        }}
                        className={`px-3 py-2 font-bold rounded-lg focus:ring-2 transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs ${
                          filterOutFranchises 
                            ? 'bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 focus:ring-orange-300'
                            : 'bg-white text-gray-700 border border-gray-300 hover:border-orange-400 hover:bg-orange-50 focus:ring-orange-200'
                        }`}
                        title={filterOutFranchises ? 'Show chain restaurants' : 'Hide chain restaurants (McDonald\'s, Subway, etc.)'}
                      >
                        <span>🚫</span>
                        <span className="hidden sm:inline">
                          {filterOutFranchises ? 'Chains Off' : 'Hide Chains'}
                        </span>
                      </button>
                      
                      {/* Zero Rating Filter Button */}
                      <button
                        onClick={() => {
                          setFilterOutZeroRating(!filterOutZeroRating);
                          setRestaurantPage(1); // Reset pagination
                        }}
                        className={`px-3 py-2 font-bold rounded-lg focus:ring-2 transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs ${
                          filterOutZeroRating 
                            ? 'bg-gradient-to-r from-yellow-500 to-amber-500 text-white hover:from-yellow-600 hover:to-amber-600 focus:ring-yellow-300'
                            : 'bg-white text-gray-700 border border-gray-300 hover:border-yellow-400 hover:bg-yellow-50 focus:ring-yellow-200'
                        }`}
                        title={filterOutZeroRating ? 'Show unrated restaurants' : 'Hide unrated restaurants (0 stars)'}
                      >
                        <span>⭐</span>
                        <span className="hidden sm:inline">
                          {filterOutZeroRating ? '0★ Off' : 'Hide 0★'}
                        </span>
                      </button>
                      
                      {/* No Full Address Filter Button */}
                      <button
                        onClick={() => {
                          setFilterOutNoFullAddress(!filterOutNoFullAddress);
                          setRestaurantPage(1); // Reset pagination
                        }}
                        className={`px-3 py-2 font-bold rounded-lg focus:ring-2 transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs ${
                          filterOutNoFullAddress 
                            ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white hover:from-blue-600 hover:to-cyan-600 focus:ring-blue-300'
                            : 'bg-white text-gray-700 border border-gray-300 hover:border-blue-400 hover:bg-blue-50 focus:ring-blue-200'
                        }`}
                        title={filterOutNoFullAddress ? 'Show restaurants without full address' : 'Hide restaurants without full address'}
                      >
                        <span>📍</span>
                        <span className="hidden sm:inline">
                          {filterOutNoFullAddress ? 'Addr Off' : 'No Address'}
                        </span>
                      </button>
                      
                      {/* Cached Filter Button */}
                      <button
                        onClick={() => {
                          setFilterOutCached(!filterOutCached);
                          setRestaurantPage(1); // Reset pagination
                        }}
                        disabled={!yelpResults?.results?.some(r => r.coverageQuality === 'cached')}
                        className={`px-3 py-2 font-bold rounded-lg focus:ring-2 transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs ${
                          filterOutCached 
                            ? 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white hover:from-purple-600 hover:to-indigo-600 focus:ring-purple-300'
                            : yelpResults?.results?.some(r => r.coverageQuality === 'cached')
                              ? 'bg-white text-gray-700 border border-gray-300 hover:border-purple-400 hover:bg-purple-50 focus:ring-purple-200'
                              : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed opacity-50'
                        }`}
                        title={yelpResults?.results?.some(r => r.coverageQuality === 'cached') ? (filterOutCached ? 'Show cached restaurants' : 'Hide cached restaurants') : 'No cached restaurants available'}
                      >
                        <span>💾</span>
                        <span className="hidden sm:inline">
                          {filterOutCached ? 'Cached Off' : 'Hide Cached'}
                        </span>
                      </button>
                      
                      {/* Filter Button with Dropdown */}
                      <div className="relative" data-filter-dropdown>
                        <button
                          onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                          className="px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-bold rounded-lg hover:from-purple-600 hover:to-pink-600 focus:ring-2 focus:ring-purple-300 transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.01] active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap text-sm"
                        >
                          <span>Filter</span>
                          <span className="text-xs">{showFilterDropdown ? '▲' : '▼'}</span>
                        </button>
                        
                        {/* Dropdown Menu */}
                        {showFilterDropdown && (
                          <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border-2 border-purple-200 z-50 min-w-[200px] overflow-hidden">
                            <div className="p-2">
                              <div className="text-xs font-bold text-gray-600 px-2 py-1 uppercase">Sort By</div>
                              
                              {/* Alphabetical Option */}
                              <button
                                onClick={() => {
                                  if (restaurantSortType === 'alphabetical') {
                                    setRestaurantSortOrder(restaurantSortOrder === 'asc' ? 'desc' : 'asc');
                                  } else {
                                    setRestaurantSortType('alphabetical');
                                    setRestaurantSortOrder('asc');
                                  }
                                  setRestaurantPage(1);
                                }}
                                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-between ${
                                  restaurantSortType === 'alphabetical'
                                    ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white'
                                    : 'text-gray-700 hover:bg-purple-50'
                                }`}
                              >
                                <span>Alphabetical</span>
                                {restaurantSortType === 'alphabetical' && (
                                  <span className="text-xs">
                                    {restaurantSortOrder === 'asc' ? 'A→Z ↑' : 'Z→A ↓'}
                                  </span>
                                )}
                              </button>
                              
                              {/* Rating Option */}
                              <button
                                onClick={() => {
                                  if (restaurantSortType === 'rating') {
                                    setRestaurantSortOrder(restaurantSortOrder === 'asc' ? 'desc' : 'asc');
                                  } else {
                                    setRestaurantSortType('rating');
                                    setRestaurantSortOrder('desc'); // Default to high to low
                                  }
                                  setRestaurantPage(1);
                                }}
                                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-between mt-1 ${
                                  restaurantSortType === 'rating'
                                    ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white'
                                    : 'text-gray-700 hover:bg-purple-50'
                                }`}
                              >
                                <span>⭐ Rating</span>
                                {restaurantSortType === 'rating' && (
                                  <span className="text-xs">
                                    {restaurantSortOrder === 'desc' ? 'High→Low ↓' : 'Low→High ↑'}
                                  </span>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section 3: Bulk Actions & Selection Controls */}
                {processedRestaurants.length > 0 && (
                  <div className="bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 px-4 py-3">
                    <div className="space-y-2.5">
                      {/* Selection Status */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            {selectionStats.totalSelected > 0 ? (
                              <>
                                <span className="inline-flex items-center gap-1 bg-emerald-500 text-white px-2.5 py-0.5 rounded-full text-xs font-bold shadow-sm">
                                  <span className="text-sm">✓</span>
                                  {selectionStats.totalSelected} selected
                                </span>
                                {selectionStats.hasHiddenSelections && (
                                  <span className="text-[10px] text-gray-600">
                                    ({selectionStats.visibleSelected} visible, {selectionStats.totalSelected - selectionStats.visibleSelected} hidden)
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-gray-600 font-medium">Select restaurants to bulk approve/reject</span>
                            )}
                          </div>
                          {selectionStats.hasHiddenSelections && (
                            <span className="text-[10px] text-amber-600 font-medium flex items-center gap-0.5">
                              <span>⚠️</span>
                              Some selected restaurants are hidden by current filters
                            </span>
                          )}
                          {selectionStats.totalSelected === 0 && (
                            <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
                              <span>💡</span>
                              Tip: Press Ctrl+A to select all visible
                            </span>
                          )}
                        </div>
                        {selectionStats.totalSelected > 0 && (
                          <button
                            onClick={deselectAll}
                            className="text-[10px] text-gray-600 hover:text-gray-900 underline font-semibold transition-colors"
                            title="Or press Escape"
                          >
                            Clear all
                          </button>
                        )}
                      </div>

                      {/* Action Buttons Row */}
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        {/* Left: Selection Controls */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {paginatedRestaurants.length > 0 && (
                            <>
                              <button
                                onClick={allOnPageSelected ? () => {
                                  const pageIds = paginatedRestaurants.map(r => r.id);
                                  setSelectedRestaurantIds(prev => {
                                    const next = new Set(prev);
                                    pageIds.forEach(id => next.delete(id));
                                    return next;
                                  });
                                } : selectAllOnPage}
                                className="px-2.5 py-1.5 text-[11px] font-semibold bg-white text-gray-700 rounded-md border border-gray-300 hover:border-gray-500 hover:bg-gray-50 transition-all shadow-sm"
                              >
                                {allOnPageSelected ? 'Deselect Page' : 'Select Page'}
                              </button>
                              {selectionStats.hasSearchOrFilter && (
                                <button
                                  onClick={allVisibleSelected ? () => {
                                    const visibleIds = processedRestaurants.map(r => r.id);
                                    setSelectedRestaurantIds(prev => {
                                      const next = new Set(prev);
                                      visibleIds.forEach(id => next.delete(id));
                                      return next;
                                    });
                                  } : selectAllVisible}
                                  className="px-2.5 py-1.5 text-[11px] font-semibold bg-white text-gray-700 rounded-md border border-gray-300 hover:border-gray-500 hover:bg-gray-50 transition-all shadow-sm"
                                >
                                  {allVisibleSelected ? 'Deselect Visible' : 'Select Visible'}
                                </button>
                              )}
                              <button
                                onClick={allSelected ? deselectAll : selectAll}
                                className="px-2.5 py-1.5 text-[11px] font-semibold bg-white text-gray-700 rounded-md border border-gray-300 hover:border-gray-500 hover:bg-gray-50 transition-all shadow-sm"
                              >
                                {allSelected ? 'Deselect All' : 'Select All'}
                              </button>
                            </>
                          )}
                        </div>

                        {/* Right: Approve/Reject & Export Buttons */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={() => handleBulkRestaurantReview('approved')}
                            disabled={selectedRestaurantIds.size === 0 || isBulkUpdating}
                            className="px-4 py-1.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-xs font-bold rounded-lg hover:from-green-600 hover:to-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-[1.01] active:scale-95"
                          >
                            {isBulkUpdating ? (
                              <span className="flex items-center justify-center gap-1.5">
                                <span className="animate-spin">⏳</span> Processing...
                              </span>
                            ) : (
                              <span className="flex items-center justify-center gap-1.5">
                                <span>✓</span> Approve Selected ({selectedRestaurantIds.size})
                              </span>
                            )}
                          </button>
                          <button
                            onClick={() => handleBulkRestaurantReview('rejected')}
                            disabled={selectedRestaurantIds.size === 0 || isBulkUpdating}
                            className="px-4 py-1.5 bg-gradient-to-r from-red-500 to-rose-600 text-white text-xs font-bold rounded-lg hover:from-red-600 hover:to-rose-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-[1.01] active:scale-95"
                          >
                            {isBulkUpdating ? (
                              <span className="flex items-center justify-center gap-1.5">
                                <span className="animate-spin">⏳</span> Processing...
                              </span>
                            ) : (
                              <span className="flex items-center justify-center gap-1.5">
                                <span>✗</span> Reject Selected ({selectedRestaurantIds.size})
                              </span>
                            )}
                          </button>

                          {/* Export Button - CSV Only */}
                          {selectionStats.totalSelected > 0 && (
                            <button
                              onClick={exportSelectedRestaurantsCSV}
                              disabled={isBulkUpdating}
                              className="px-3 py-2 bg-gradient-to-r from-teal-500 to-cyan-600 text-white text-[11px] font-bold rounded-lg hover:from-teal-600 hover:to-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md transform hover:scale-[1.01] active:scale-95"
                              title="Export to CSV"
                            >
                              📊 Export CSV
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Restaurant List */}
              {paginatedRestaurants.length > 0 ? (
                <>
                  <div className="space-y-2">
                  {paginatedRestaurants.map((restaurant, idx) => (
                <div key={restaurant.id || idx} className={`group bg-gradient-to-br from-white via-blue-50/20 to-purple-50/20 p-3 rounded-xl border transition-all duration-200 ${
                  selectedRestaurantIds.has(restaurant.id) 
                    ? 'border-green-400 shadow-lg bg-green-50/30' 
                    : 'border-gray-200 hover:border-purple-300 hover:shadow-md'
                }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={selectedRestaurantIds.has(restaurant.id)}
                        onChange={() => toggleRestaurantSelection(restaurant.id)}
                        disabled={updatingRestaurantIds.has(restaurant.id) || isBulkUpdating}
                        className="mt-0.5 w-4 h-4 text-green-600 border border-gray-300 rounded focus:ring-2 focus:ring-green-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        {/* Title Row */}
                        <div className="flex items-center flex-wrap gap-1.5 mb-1.5">
                          <h5 className="font-bold text-gray-900 text-base group-hover:text-purple-600 transition-colors leading-tight">{restaurant.name}</h5>
                          {yelpResults.fromCache && (
                            <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                              <span>💾</span> Cached
                            </span>
                          )}
                          {reviewedRestaurantIds.has(restaurant.id) && reviewedRestaurantStatus.get(restaurant.id) === 'approved' && (
                            <span className="bg-gradient-to-r from-green-500 to-emerald-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                              <span className="text-xs">✓</span> Approved
                            </span>
                          )}
                          {reviewedRestaurantIds.has(restaurant.id) && reviewedRestaurantStatus.get(restaurant.id) === 'rejected' && (
                            <span className="bg-gradient-to-r from-red-500 to-rose-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm flex items-center gap-0.5">
                              <span className="text-xs">✗</span> Rejected
                            </span>
                          )}
                          <div className="flex items-center gap-0.5 bg-yellow-100 px-2 py-0.5 rounded-full">
                            <span className="text-yellow-600 text-sm">⭐</span>
                            <span className="text-yellow-700 font-bold text-xs">{restaurant.rating}</span>
                          </div>
                          {restaurant.price && (
                            <span className="bg-gradient-to-r from-green-400 to-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm">
                              {restaurant.price}
                            </span>
                          )}
                        </div>
                        {/* Info Row 1: Category, Location, Phone */}
                        <div className="flex items-center flex-wrap gap-1.5 text-xs mb-1">
                          {restaurant.categories?.[0]?.title && (
                            <span className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white px-2 py-0.5 rounded-full font-semibold shadow-sm">
                              {restaurant.categories[0].title}
                            </span>
                          )}
                          <span className="text-gray-700 font-medium">📍 {restaurant.location.city}, {restaurant.location.state}</span>
                          {restaurant.phone && (
                            <span className="text-gray-600">📞 {restaurant.phone}</span>
                          )}
                        </div>
                        {/* Info Row 2: Address & Distance */}
                        <div className="flex items-center flex-wrap gap-2 text-xs text-gray-600">
                          <span className="bg-gray-50 px-2 py-0.5 rounded">
                            {restaurant.location.address1}, {restaurant.location.zip_code}
                          </span>
                          <span className="text-purple-600 font-medium">
                            {metersToMiles(restaurant.distance)} mi
                          </span>
                        </div>
                      </div>
                    </div>
                    {/* Right side actions */}
                    <div className="flex flex-col items-end gap-1.5 flex-shrink-0 min-w-[140px]">
                      <a 
                        href={restaurant.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="inline-block bg-gradient-to-r from-red-500 to-orange-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:from-red-600 hover:to-orange-600 transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-105 whitespace-nowrap"
                      >
                        View on Yelp →
                      </a>
                      {/* Review buttons */}
                      <div className="flex gap-1.5 w-full">
                        <button
                          onClick={() => handleRestaurantReview(restaurant.id, 'approved')}
                          disabled={updatingRestaurantIds.has(restaurant.id)}
                          className="flex-1 px-2.5 py-1.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-xs font-bold rounded-lg hover:from-green-600 hover:to-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-105 active:scale-95 whitespace-nowrap"
                        >
                          {updatingRestaurantIds.has(restaurant.id) ? '⏳' : (yelpResults.fromCache ? '✓ Re-Approve' : '✓ Approve')}
                        </button>
                        <button
                          onClick={() => handleRestaurantReview(restaurant.id, 'rejected')}
                          disabled={updatingRestaurantIds.has(restaurant.id)}
                          className="flex-1 px-2.5 py-1.5 bg-gradient-to-r from-red-500 to-rose-600 text-white text-xs font-bold rounded-lg hover:from-red-600 hover:to-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-105 active:scale-95 whitespace-nowrap"
                        >
                          {updatingRestaurantIds.has(restaurant.id) ? '⏳' : '✗ Reject'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
                  </div>
              
                  {/* Pagination - Compact */}
                  {totalRestaurantPages > 1 && (
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-3 mt-3 border-t border-gray-200">
                      <div className="text-xs text-gray-700 text-center sm:text-left">
                        <span className="font-semibold">Page {restaurantPage} of {totalRestaurantPages}</span>
                        <span className="ml-2 text-gray-600">
                          ({paginatedRestaurants.length} of {processedRestaurants.length} restaurants)
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setRestaurantPage(p => Math.max(1, p - 1))}
                          disabled={restaurantPage === 1}
                          className="px-3 py-1.5 text-xs font-bold bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg hover:from-blue-600 hover:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:from-gray-300 disabled:to-gray-400 transition-all duration-200 shadow-sm hover:shadow-md"
                          aria-label="Previous page"
                        >
                          ← Prev
                        </button>
                        <button
                          onClick={() => setRestaurantPage(p => Math.min(totalRestaurantPages, p + 1))}
                          disabled={restaurantPage === totalRestaurantPages}
                          className="px-3 py-1.5 text-xs font-bold bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-lg hover:from-purple-600 hover:to-pink-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:from-gray-300 disabled:to-gray-400 transition-all duration-200 shadow-sm hover:shadow-md"
                          aria-label="Next page"
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center bg-gradient-to-br from-gray-50 to-blue-50 p-12 rounded-2xl border-2 border-gray-200">
                  <div className="text-6xl mb-4">🔍</div>
                  <div className="text-gray-700 text-lg font-semibold mb-2">No restaurants found</div>
                  <div className="text-gray-500 text-sm mb-4">
                    {restaurantSearch ? `No results match "${restaurantSearch}"` : 'Try adjusting your search'}
                  </div>
                  {restaurantSearch && (
                    <button
                      onClick={() => {
                        setRestaurantSearch('');
                        setRestaurantPage(1);
                      }}
                      className="px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-bold rounded-xl hover:from-purple-600 hover:to-pink-600 transition-all duration-200 shadow-md hover:shadow-xl transform hover:scale-105"
                    >
                      Clear Search
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
