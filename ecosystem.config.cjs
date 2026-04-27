module.exports = {
  apps: [{
    name: 'scs-moderator',
    script: '/Users/mikewolf/Projects/shit-claude-says/scs-moderator.py',
    interpreter: '/opt/homebrew/bin/python3',
    env: {
      SCS_API: 'https://vpsmikewolf.duckdns.org/api/scs',
      SCS_MOD_TOKEN: 'cdecddce0fa7d016b9e778e101d600cf',
    },
    restart_delay: 5000,
    max_restarts: 10,
  }]
}
