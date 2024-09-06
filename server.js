const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Initialize Express App
const app = express();
app.use(cors());

// Create HTTP Server
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*', // Adjust this in production to your frontend's origin
    methods: ['GET', 'POST']
  }
});

// In-memory storage for rooms and users
const rooms = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle creating a new room
  socket.on('createRoom', (callback) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      users: [
        { id: socket.id, username: 'Host' }
      ],
      gameStarted: false,
      prompts: [],
      responses: {},
      votes: {}
    };
    socket.join(roomCode);
    callback({ roomCode });
    console.log(`Room created: ${roomCode} by ${socket.id}`);
  });

  // Handle joining a room
  socket.on('joinRoom', ({ roomCode, username }, callback) => {
    const room = rooms[roomCode];
    if (room) {
      if (room.users.length >= 4) {
        callback({ success: false, message: 'Room is full.' });
        return;
      }
      room.users.push({ id: socket.id, username });
      socket.join(roomCode);
      io.to(roomCode).emit('updateUsers', room.users.map(user => user.username));
      callback({ success: true });
      console.log(`${username} joined room: ${roomCode}`);
    } else {
      callback({ success: false, message: 'Room not found.' });
    }
  });


  // Handle starting the game
  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
      room.gameStarted = true;
      io.to(roomCode).emit('gameStarted');
      sendNextPrompt(roomCode, 1); // Start with the first prompt
    }
  });

  // Handle submitting a response
  // socket.on('submitResponse', ({ roomCode, response }) => {
  //   const room = rooms[roomCode];
  //   if (room && room.gameStarted) {
  //     const user = room.users.find(u => u.id === socket.id);
  //     if (user && !room.responses[user.username]) {
  //       room.responses[user.username] = response;
  //       io.to(roomCode).emit('userSubmitted', { userId: user.username });
  //       console.log(`Response from ${user.username} in room ${roomCode}`);
  //       // Check if all responses are in
  //       if (Object.keys(room.responses).length === room.users.length) {
  //         // All users have submitted their response
  //         io.to(roomCode).emit('showResponses', room.responses);
  //         clearTimeout(room.timer); // Clear timer since all responses are in
  //       }        

  //     }
  //   }
  // });

  // Handle submitting a response
  socket.on('submitResponse', ({ roomCode, response }) => {
    const room = rooms[roomCode];
    if (room && room.gameStarted) {
      const user = room.users.find(u => u.id === socket.id);
      if (user && !room.responses[user.username]) {
        room.responses[user.username] = response;
        io.to(roomCode).emit('userSubmitted', { userId: user.username });
        // Check if all responses are in
        if (Object.keys(room.responses).length === room.users.length) {
          // All users have submitted their response
          io.to(roomCode).emit('showResponses', room.responses);
          io.to(roomCode).emit('startVoting');  // Start voting for all users
          startVotingTimer(roomCode);  // Start voting timer on server
        }
      }
    }
  });



  // Handle voting
  socket.on('vote', ({ roomCode, votedUserId }) => {
    const room = rooms[roomCode];
    if (room && room.gameStarted) {
      const user = room.users.find(u => u.id === socket.id);
      if (user && !room.votes[user.username]) {
        room.votes[user.username] = votedUserId;
        io.to(roomCode).emit('userVoted', { voter: user.username, voted: votedUserId });
        console.log(`${user.username} voted for ${votedUserId} in room ${roomCode}`);

        // Check if all votes are in
        if (Object.keys(room.votes).length === room.users.length) {
          const winner = determineWinner(room.votes);
          io.to(roomCode).emit('roundWinner', { winner });

          clearTimeout(room.timer); // Clear the timer after the voting phase is done

          // Ask the host if they want to play again after announcing the winner
          io.to(room.host).emit('askToPlayAgain', { message: "Do you want to play again?" });

          // clearTimeout(room.timer); // Clear any running timer
          room.gameStarted = false; // End the game until host chooses to play again
        }        

      }
    }
  });




  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Remove user from rooms
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const userIndex = room.users.findIndex(u => u.id === socket.id);
      if (userIndex !== -1) {
        const [user] = room.users.splice(userIndex, 1);
        io.to(roomCode).emit('updateUsers', getUsernames(room.users));
        // If host leaves, assign new host or delete room
        if (room.host === socket.id) {
          if (room.users.length > 0) {
            room.host = room.users[0].id;
            io.to(roomCode).emit('newHost', room.users[0].username);
          } else {
            delete rooms[roomCode];
            console.log(`Room deleted: ${roomCode}`);
          }
        }
        break;
      }
    }
  });

  socket.on('playAgain', (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
      room.gameStarted = true;
      sendNextPrompt(roomCode, 1); // Start a new round with a new prompt
    }
  });

  // Handle voting timeout
  socket.on('voteTimeout', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if any votes were cast
    if (Object.keys(room.votes).length === 0) {
      // No votes were cast, so declare all participants as tied with 0 votes
      const tiedWinners = room.users.map(user => user.username);
      io.to(roomCode).emit('roundWinner', { winner: tiedWinners });
    } else {
      // Tally the votes and determine the winner
      const winner = determineWinner(room.votes);
      io.to(roomCode).emit('roundWinner', { winner });
    }

    clearTimeout(room.timer); // Clear any running timer
    room.gameStarted = false; // End the game until host chooses to play again
  });
  



});

// Utility Functions

function generateRoomCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  // Ensure unique code
  if (rooms[code]) {
    return generateRoomCode();
  }
  return code;
}

function getUsernames(users) {
  return users.map(user => user.username);
}


function getRandomPrompt() {
  const prompts = [
    "What's your favorite movie?",
    "Describe your perfect day.",
    "What's the most memorable trip you've taken?",
    "If you could have any superpower, what would it be?"
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function sendNextPrompt(roomCode, promptNumber) {
  const room = rooms[roomCode];
  if (!room) return;

  // Clear any existing timer before starting a new round
  if (room.timer) {
    clearTimeout(room.timer);
  }

  const prompt = getRandomPrompt();
  room.responses = {};  // Clear previous responses
  room.votes = {};      // Clear previous votes

  io.to(roomCode).emit('newPrompt', { prompt, promptNumber });

  // Set a 60-second timer for the round
  room.timer = setTimeout(() => {
    if (Object.keys(room.responses).length > 0) {
      io.to(roomCode).emit('showResponses', room.responses);
      // Proceed with showing responses and asking for votes
    } else {
      io.to(roomCode).emit('noResponses', { message: "No responses received in time." });
    }
  }, 60000); // Example of 60 seconds for response time
}

function determineWinner(votes) {
  const voteCounts = {};
  for (const voter in votes) {
    const voted = votes[voter];
    voteCounts[voted] = (voteCounts[voted] || 0) + 1;
  }

  let winners = [];
  let maxVotes = 0;

  // Find the player(s) with the highest vote count
  for (const user in voteCounts) {
    if (voteCounts[user] > maxVotes) {
      maxVotes = voteCounts[user];
      winners = [user]; // Replace winners array
    } else if (voteCounts[user] === maxVotes) {
      winners.push(user); // Add to winners array (tie)
    }
  }

  if (winners.length === 1) {
    return winners[0]; // Single winner
  } else {
    return winners; // Return array of tied winners
  }
}

// Start the voting timer on the server
function startVotingTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.timer = setTimeout(() => {
    io.to(roomCode).emit('voteTimeout', roomCode);  // Emit vote timeout to all users
  }, 30000); // 30-second timer for voting
}

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
