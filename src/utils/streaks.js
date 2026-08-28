export function calculateStreaks(dates) {
  if (!dates || dates.length === 0) {
    return { currentStreak: 0, longestStreak: 0, totalActiveDays: 0 };
  }

  // Deduplicate and sort dates in ascending order
  const uniqueDates = [...new Set(dates)].sort();
  const totalActiveDays = uniqueDates.length;

  let longestStreak = 1;
  let currentStreakVal = 1;

  for (let i = 1; i < uniqueDates.length; i++) {
    const d1 = new Date(uniqueDates[i - 1]);
    const d2 = new Date(uniqueDates[i]);
    const diffDays = Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentStreakVal++;
      longestStreak = Math.max(longestStreak, currentStreakVal);
    } else if (diffDays > 1) {
      currentStreakVal = 1;
    }
  }

  // Calculate current streak ending today or yesterday
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  let currentStreak = 0;
  let dIndex = uniqueDates.length - 1;
  
  if (dIndex >= 0) {
    const lastDate = new Date(uniqueDates[dIndex]);
    lastDate.setUTCHours(0,0,0,0);
    
    if (lastDate.getTime() === today.getTime() || lastDate.getTime() === yesterday.getTime()) {
      currentStreak = 1;
      let expectedDate = new Date(lastDate);
      dIndex--;
      
      while (dIndex >= 0) {
        expectedDate.setUTCDate(expectedDate.getUTCDate() - 1);
        const checkDate = new Date(uniqueDates[dIndex]);
        checkDate.setUTCHours(0,0,0,0);
        
        if (checkDate.getTime() === expectedDate.getTime()) {
          currentStreak++;
          dIndex--;
        } else {
          break;
        }
      }
    }
  }

  return { currentStreak, longestStreak, totalActiveDays };
}
