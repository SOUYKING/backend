let io = null;

module.exports = {
  init: (ioInstance) => {
    io = ioInstance;
  },
  getIO: () => io,
};
