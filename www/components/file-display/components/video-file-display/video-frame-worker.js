self.addEventListener('message', (e) => {
  const { action, imageData, width, height } = e.data;

  if (action === 'processFrame') {
    try {
      const data = imageData;
      let isBlack = true;

      for (let i = 0; i < Math.min(data.length, 4000); i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 10 || g > 10 || b > 10) {
          isBlack = false;
          break;
        }
      }

      self.postMessage({
        success: true,
        isBlack,
        imageData
      });
    } catch (error) {
      self.postMessage({
        success: false,
        error: error.message
      });
    }
  }
});
