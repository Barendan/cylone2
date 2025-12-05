'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import dynamic from 'next/dynamic';
import type { EnhancedCityResponse } from '@/lib/geography/cityTypes';
import type { YelpTestResult } from '../components/CityMap/index';
import LoadingModal from '../components/LoadingModal';

// Dynamically import the map component to avoid SSR issues
const CityMap = dynamic(() => import('../components/CityMap/index'), { ssr: false });

interface FormData {
  cityName: string;
}

const LOADING_STEPS = [
  'Searching for city boundary...',
  'Processing city data...',
  'Generating hexagon grid...',
  'Finalizing map...'
];

export default function Home() {
  const [cityData, setCityData] = useState<EnhancedCityResponse | null>(null);
  const [restaurantData, setRestaurantData] = useState<YelpTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>();

  // Simulate progress steps during loading
  useEffect(() => {
    if (!loading) {
      setLoadingStep(1);
      return;
    }

    // Progress through steps with timing
    const stepTimers: NodeJS.Timeout[] = [];
    
    // Step 1: Start immediately
    // Step 2: After 0.5s
    stepTimers.push(setTimeout(() => setLoadingStep(2), 500));
    // Step 3: After 1.5s
    stepTimers.push(setTimeout(() => setLoadingStep(3), 1500));
    // Step 4: After 2.5s (will be overridden when API completes)
    stepTimers.push(setTimeout(() => setLoadingStep(4), 2500));

    return () => {
      stepTimers.forEach(timer => clearTimeout(timer));
    };
  }, [loading]);

  const onSubmit = async (data: FormData) => {
    setLoading(true);
    setLoadingStep(1);
    setError(null);
    setStats(null);
    setRestaurantData(null); // Reset restaurant data when searching new city

    try {
      // Step 1: Searching
      setLoadingStep(1);
      
      const response = await fetch(`/api/city?name=${encodeURIComponent(data.cityName)}`);
      
      // Step 2: Processing
      setLoadingStep(2);
      
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to fetch city data');
      }

      // Step 3: Generating grid
      setLoadingStep(3);
      
      setCityData(result);
      
      // Calculate enhanced stats
      const geojson = result.geojson;
      let ringCount = 0;

      if (geojson.geometry.type === 'Polygon') {
        ringCount = geojson.geometry.coordinates.length;
      } else if (geojson.geometry.type === 'MultiPolygon') {
        ringCount = geojson.geometry.coordinates.reduce((acc: number, polygon: number[][][]) =>
          acc + polygon.length, 0);
      }

      // Enhanced stats including H3 grid information
      const gridStats = result.grid_stats;
      const enhancedStats = `${ringCount} polygon ring${ringCount !== 1 ? 's' : ''} rendered via ${result.source} | ${gridStats.total_hexagons} H3 hexagons (${gridStats.coverage_area_km2.toFixed(1)} km² coverage)`;
      
      setStats(enhancedStats);
      
      // Step 4: Finalizing
      setLoadingStep(4);
      
      // Small delay before closing to show completion
      await new Promise(resolve => setTimeout(resolve, 300));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
      setLoadingStep(1);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <LoadingModal 
        isOpen={loading}
        currentStep={loadingStep}
        totalSteps={LOADING_STEPS.length}
        stepLabels={LOADING_STEPS}
      />
      
      <div className="max-w-4xl mx-auto">
        <header className="text-center mb-4">
          <h1 className="text-3xl font-bold text-gray-900">
            Restaurant Intelligence Project
          </h1>
          <p className="text-gray-600">
            Find, process, and review restaurants in any city.
          </p>
        </header>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-2">
          <form onSubmit={handleSubmit(onSubmit)} className="flex gap-4">
            <div className="flex-1">
              <input
                {...register('cityName', { required: 'City name is required' })}
                type="text"
                placeholder="Miami, FL"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-medium text-gray-900"
                disabled={loading}
              />
              {errors.cityName && (
                <p className="text-red-500 text-sm mt-1">{errors.cityName.message}</p>
              )}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Loading...' : 'View City'}
            </button>
          </form>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-800">{error}</p>
          </div>
        )}


        {/* Enhanced Grid Statistics */}
        {cityData && cityData.grid_stats && (() => {
          // Calculate fetched/cached hexagon count
          const fetchedCount = restaurantData?.results?.filter(
            r => r.status === 'fetched' || r.status === 'dense'
          ).length || 0;
          
          // Calculate restaurant count from unique businesses in results
          const restaurantCount = restaurantData?.newBusinesses?.length || 
                                restaurantData?.processingStats?.newRestaurantsCount || 
                                restaurantData?.processingStats?.totalRequested || 0;

          
          return (
            <div className="relative overflow-hidden bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 border border-emerald-200/60 rounded-xl shadow-sm mb-4">
              {/* Subtle background pattern */}
              <div className="absolute inset-0 opacity-[0.03]" style={{
                backgroundImage: 'radial-gradient(circle at 2px 2px, rgb(16 185 129) 1px, transparent 0)',
                backgroundSize: '32px 32px'
              }}></div>
              
              <div className="relative px-4 py-3">
                {/* Compact header with inline title */}
                <div className="flex items-center justify-between">
                  <h3 className="text-md font-semibold text-emerald-800 flex items-center gap-2">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    H3 Grid Analysis
                  </h3>
                  <div className="h-1 w-12 bg-gradient-to-r from-emerald-400 to-teal-400 rounded-full"></div>
                </div>

                {/* Horizontal stats - single row */}
                <div className="flex items-stretch gap-3">
                  {/* Stat 1: Total/Cached */}
                  <div className="flex-1 group">
                    <div className="h-full px-3 py-2.5 hover:border-emerald-300 hover:shadow-md transition-all duration-200">
                      <div className="flex items-baseline justify-center gap-1.5">
                        <span className="text-3xl font-bold text-emerald-600 tracking-tight">
                          {cityData.grid_stats.total_hexagons}
                        </span>
                        <span className="text-xl font-semibold text-gray-400">/</span>
                        <span className="text-2xl font-semibold text-gray-500">
                          {fetchedCount}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-emerald-700/90 text-center mt-1.5 uppercase tracking-wide">
                        Total / Cached
                      </div>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="w-px bg-gradient-to-b from-transparent via-emerald-200 to-transparent"></div>

                  {/* Stat 2: Resolution */}
                  <div className="flex-1 group">
                    <div className="h-full px-3 py-2.5 hover:border-emerald-300 hover:shadow-md transition-all duration-200">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-3xl font-bold text-emerald-600 tracking-tight">
                          {cityData.grid_stats.resolution}
                        </span>
                        {cityData.grid_stats.resolution === 7 && (
                          <span className="text-xs font-bold text-emerald-600 bg-emerald-100 px-2 py-1 rounded-md">
                            BASE
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-semibold text-emerald-700/90 text-center mt-1.5 uppercase tracking-wide">
                        Resolution
                      </div>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="w-px bg-gradient-to-b from-transparent via-emerald-200 to-transparent"></div>

                  {/* Stat 3: Area */}
                  <div className="flex-1 group">
                    <div className="h-full px-3 py-2.5 hover:border-emerald-300 hover:shadow-md transition-all duration-200">
                      <div className="flex items-baseline justify-center gap-1.5">
                        <span className="text-3xl font-bold text-emerald-600 tracking-tight">
                          {cityData.grid_stats.avg_hexagon_size_km.toFixed(1)}
                        </span>
                        <span className="text-sm font-semibold text-gray-500">km²</span>
                      </div>
                      <div className="flex items-center justify-center gap-1.5 mt-1">
                        <span className="text-xs font-semibold text-emerald-600">
                          {cityData.grid_stats.coverage_area_km2.toFixed(1)}
                        </span>
                        <span className="text-xs font-medium text-gray-500">total</span>
                        <span className="text-xs font-semibold text-emerald-700/90 uppercase tracking-wide">Area</span>
                      </div>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="w-px bg-gradient-to-b from-transparent via-emerald-200 to-transparent"></div>

                  {/* Stat 4: Restaurants */}
                  <div className="flex-1 group">
                    <div className="h-full px-3 py-2.5 hover:border-emerald-300 hover:shadow-md transition-all duration-200">
                      <div className="flex items-center justify-center">
                        <span className="text-3xl font-bold text-emerald-600 tracking-tight">
                          {restaurantCount}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-emerald-700/90 text-center mt-1.5 uppercase tracking-wide">
                        Restaurants
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        <div className="bg-white rounded-lg shadow-sm p-6">
          <CityMap cityData={cityData} onRestaurantDataChange={setRestaurantData} />
        </div>

        {cityData && (
          <div className="mt-4 text-center text-sm text-gray-600">
            <p>Showing: <strong>{cityData.name}</strong> (OSM ID: {cityData.osm_id})</p>
            <p className="text-xs text-gray-500 mt-1">Data source: {cityData.source}</p>
          </div>
        )}
      </div>
    </div>
  );
}
