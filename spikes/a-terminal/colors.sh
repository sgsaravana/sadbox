#!/bin/sh
# Truecolor / 256-color sanity check — run INSIDE the web terminal's tmux.
echo "TERM=$TERM COLORTERM=$COLORTERM colors=$(tput colors)"
awk 'BEGIN{ for (c=0; c<256; c++) { printf "\033[48;5;%dm  ", c; if ((c+1)%32==0) printf "\033[0m\n" } printf "\033[0m" }'
awk 'BEGIN{ cols=78; for (i=0;i<cols;i++){ r=int(255*i/cols); g=int(255*(cols-i)/cols); printf "\033[48;2;%d;%d;128m ", r, g } printf "\033[0m\n" }'
echo "smooth gradient above = truecolor OK; visible banding = 256-color fallback"
