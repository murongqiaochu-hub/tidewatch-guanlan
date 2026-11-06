/* Independently authored 2026-10-15. No vips, subprocess codec or vendor implementation copied. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <png.h>
#include <jpeglib.h>
#include <webp/decode.h>
#include <webp/encode.h>

#define MAX_PIXELS 64000000ULL
#define MAX_BYTES (64ULL*1024*1024)
#define MAX_OUTPUT (2ULL*1024*1024)
static void die(const char *message) { fprintf(stderr,"codec: %s\n",message); exit(2); }
static void *alloc(size_t n) { void *p=calloc(n?n:1,1); if(!p) die("memory_budget"); return p; }
static void dimensions(uint32_t w,uint32_t h) { if(!w||!h||(uint64_t)w*h>MAX_PIXELS)die("source_pixel_budget"); }
static unsigned number(const char *s) { char *end; errno=0; unsigned long n=strtoul(s,&end,10); if(errno||!*s||*end||n>64000000UL||*s=='-')die("invalid_number"); return (unsigned)n; }
static void png_error_exit(png_structp p,png_const_charp m) { (void)p;(void)m;die("invalid_png"); }
static void png_warning_ignore(png_structp p,png_const_charp m) { (void)p;fprintf(stderr,"codec png warning: %.128s\n",m); }
static void jpeg_error_exit(j_common_ptr p) { (void)p;die("invalid_jpeg"); }
static void jpeg_message(j_common_ptr p,int level) { (void)p;if(level<0)die("truncated_jpeg"); }

typedef struct { FILE *file; uint32_t w,h,next; int kind,depth,channels; size_t stride; unsigned char *rows[2],*full; png_structp png; png_infop info; struct jpeg_decompress_struct jpeg; struct jpeg_error_mgr jerr; } Source;
static void source_open(Source *s,FILE *f,int native) {
  memset(s,0,sizeof(*s));s->file=f;
  unsigned char magic[12];if(fread(magic,1,12,f)!=12)die("truncated_input");rewind(f);
  if(!png_sig_cmp(magic,0,8)) {
    s->kind=1;s->png=png_create_read_struct(PNG_LIBPNG_VER_STRING,NULL,png_error_exit,png_warning_ignore);if(!s->png)die("memory_budget");
    s->info=png_create_info_struct(s->png);if(!s->info)die("memory_budget");
    png_set_user_limits(s->png,64000000,64000000);png_set_chunk_malloc_max(s->png,8*1024*1024);png_set_chunk_cache_max(s->png,64);
    png_set_crc_action(s->png,PNG_CRC_ERROR_QUIT,PNG_CRC_ERROR_QUIT);png_init_io(s->png,f);png_read_info(s->png,s->info);
    s->w=png_get_image_width(s->png,s->info);s->h=png_get_image_height(s->png,s->info);dimensions(s->w,s->h);
    s->depth=png_get_bit_depth(s->png,s->info);int color=png_get_color_type(s->png,s->info);
    if(s->depth==16&&!native){png_set_strip_16(s->png);s->depth=8;}
    if(color==PNG_COLOR_TYPE_PALETTE)png_set_palette_to_rgb(s->png);
    if(color==PNG_COLOR_TYPE_GRAY&&s->depth<8)png_set_expand_gray_1_2_4_to_8(s->png);
    int trns=png_get_valid(s->png,s->info,PNG_INFO_tRNS);if(trns)png_set_tRNS_to_alpha(s->png);
    if(color==PNG_COLOR_TYPE_GRAY||color==PNG_COLOR_TYPE_GRAY_ALPHA)png_set_gray_to_rgb(s->png);
    if(!(color&PNG_COLOR_MASK_ALPHA)&&!trns)png_set_add_alpha(s->png,s->depth==16?65535:255,PNG_FILLER_AFTER);
    int passes=png_set_interlace_handling(s->png);png_read_update_info(s->png,s->info);
    s->depth=png_get_bit_depth(s->png,s->info);s->channels=4;s->stride=png_get_rowbytes(s->png,s->info);
    if(s->stride!=(size_t)s->w*4*(s->depth==16?2:1))die("invalid_png_stride");
    if(passes>1){if((uint64_t)s->stride*s->h>300ULL*1024*1024)die("interlaced_memory_budget");s->full=alloc(s->stride*s->h);for(int pass=0;pass<passes;pass++)for(uint32_t y=0;y<s->h;y++)png_read_row(s->png,s->full+(size_t)y*s->stride,NULL);s->next=s->h;}
  } else if(magic[0]==255&&magic[1]==216) {
    if(native)die("native_requires_png");s->kind=2;s->depth=8;s->channels=3;s->jpeg.err=jpeg_std_error(&s->jerr);s->jerr.error_exit=jpeg_error_exit;s->jerr.emit_message=jpeg_message;
    jpeg_create_decompress(&s->jpeg);jpeg_stdio_src(&s->jpeg,f);jpeg_read_header(&s->jpeg,TRUE);dimensions(s->jpeg.image_width,s->jpeg.image_height);
    if(s->jpeg.jpeg_color_space==JCS_CMYK||s->jpeg.jpeg_color_space==JCS_YCCK)die("cmyk_not_supported");
    s->jpeg.out_color_space=JCS_RGB;s->jpeg.mem->max_memory_to_use=16*1024*1024;jpeg_start_decompress(&s->jpeg);s->w=s->jpeg.output_width;s->h=s->jpeg.output_height;s->stride=(size_t)s->w*3;
  } else if(!memcmp(magic,"RIFF",4)&&!memcmp(magic+8,"WEBP",4)) {
    if(native)die("native_requires_png");s->kind=3;s->depth=8;s->channels=4;struct stat st;if(fstat(fileno(f),&st)||st.st_size<12||st.st_size>MAX_BYTES)die("source_byte_budget");
    unsigned char *encoded=alloc((size_t)st.st_size);if(fread(encoded,1,(size_t)st.st_size,f)!=(size_t)st.st_size)die("input_read_failed");
    WebPDecoderConfig cfg;if(!WebPInitDecoderConfig(&cfg)||WebPGetFeatures(encoded,(size_t)st.st_size,&cfg.input)!=VP8_STATUS_OK)die("invalid_webp");
    if(cfg.input.has_animation)die("animated_webp_not_supported");s->w=cfg.input.width;s->h=cfg.input.height;dimensions(s->w,s->h);s->stride=(size_t)s->w*4;s->full=alloc(s->stride*s->h);
    cfg.output.colorspace=MODE_RGBA;cfg.output.is_external_memory=1;cfg.output.u.RGBA.rgba=s->full;cfg.output.u.RGBA.stride=(int)s->stride;cfg.output.u.RGBA.size=s->stride*s->h;cfg.options.use_threads=0;
    if(WebPDecode(encoded,(size_t)st.st_size,&cfg)!=VP8_STATUS_OK)die("invalid_webp");WebPFreeDecBuffer(&cfg.output);free(encoded);s->next=s->h;
  } else die("unsupported_format");
  if(!s->full){s->rows[0]=alloc(s->stride);if(s->h>1)s->rows[1]=alloc(s->stride);else s->rows[1]=s->rows[0];}
}
static unsigned char *row(Source *s,uint32_t y) {
  if(s->full)return s->full+(size_t)y*s->stride;
  if(y+2<s->next)die("non_monotonic_sampling");
  while(s->next<=y){unsigned char *dest=s->rows[s->next%2];if(s->kind==1)png_read_row(s->png,dest,NULL);else{JSAMPROW p=dest;if(jpeg_read_scanlines(&s->jpeg,&p,1)!=1)die("jpeg_read_failed");}s->next++;}
  return s->rows[y%2];
}
static void source_finish(Source *s) {
  while(s->next<s->h)row(s,s->next);
  if(s->kind==1){png_read_end(s->png,NULL);png_destroy_read_struct(&s->png,&s->info,NULL);}else if(s->kind==2){jpeg_finish_decompress(&s->jpeg);jpeg_destroy_decompress(&s->jpeg);}
  free(s->full);if(s->rows[1]!=s->rows[0])free(s->rows[1]);free(s->rows[0]);
}
static void copy_color_metadata(Source *s,png_structp out,png_infop info) {
  double gamma;if(png_get_gAMA(s->png,s->info,&gamma))png_set_gAMA(out,info,gamma);
  double wx,wy,rx,ry,gx,gy,bx,by;if(png_get_cHRM(s->png,s->info,&wx,&wy,&rx,&ry,&gx,&gy,&bx,&by))png_set_cHRM(out,info,wx,wy,rx,ry,gx,gy,bx,by);
  int intent;if(png_get_sRGB(s->png,s->info,&intent))png_set_sRGB(out,info,intent);
  png_charp name;int compression;png_bytep profile;png_uint_32 length;if(png_get_iCCP(s->png,s->info,&name,&compression,&profile,&length))png_set_iCCP(out,info,name,compression,profile,length);
}
static void crop(Source *s,FILE *out,uint32_t x,uint32_t y,uint32_t w,uint32_t h) {
  if(s->kind!=1||x%512||y%512||x>=s->w||y>=s->h||w!=(s->w-x<512?s->w-x:512)||h!=(s->h-y<512?s->h-y:512))die("invalid_native_tile");
  png_structp p=png_create_write_struct(PNG_LIBPNG_VER_STRING,NULL,png_error_exit,png_warning_ignore);png_infop i=png_create_info_struct(p);if(!p||!i)die("memory_budget");
  png_init_io(p,out);png_set_IHDR(p,i,w,h,s->depth,PNG_COLOR_TYPE_RGBA,PNG_INTERLACE_NONE,PNG_COMPRESSION_TYPE_DEFAULT,PNG_FILTER_TYPE_DEFAULT);copy_color_metadata(s,p,i);
  png_set_compression_level(p,6);png_set_filter(p,PNG_FILTER_TYPE_BASE,PNG_FILTER_NONE);png_write_info(p,i);
  for(uint32_t oy=0;oy<h;oy++)png_write_row(p,row(s,y+oy)+(size_t)x*4*(s->depth==16?2:1));png_write_end(p,NULL);png_destroy_write_struct(&p,&i);
}
static double component(const unsigned char *pixel,int c,int channels){double a=channels==4?pixel[3]/255.0:1.0;return pixel[c]*a+255*(1-a);}
static unsigned char *resize_rgb(Source *s,uint32_t w,uint32_t h) {
  if(!w||!h||w>2048||h>2048||w>s->w||h>s->h)die("invalid_lod_dimensions");unsigned char *rgb=alloc((size_t)w*h*3);
  for(uint32_t y=0;y<h;y++){
    double sy=((double)y+0.5)*s->h/h-0.5;if(sy<0)sy=0;if(sy>s->h-1)sy=s->h-1;uint32_t y0=(uint32_t)sy,y1=y0+1<s->h?y0+1:y0;double fy=sy-y0;
    unsigned char *a=row(s,y0),*b=row(s,y1);
    for(uint32_t x=0;x<w;x++){double sx=((double)x+0.5)*s->w/w-0.5;if(sx<0)sx=0;if(sx>s->w-1)sx=s->w-1;uint32_t x0=(uint32_t)sx,x1=x0+1<s->w?x0+1:x0;double fx=sx-x0;
      for(int c=0;c<3;c++){double aa=component(a+(size_t)x0*s->channels,c,s->channels),ab=component(a+(size_t)x1*s->channels,c,s->channels),ba=component(b+(size_t)x0*s->channels,c,s->channels),bb=component(b+(size_t)x1*s->channels,c,s->channels);double v=(aa*(1-fx)+ab*fx)*(1-fy)+(ba*(1-fx)+bb*fx)*fy;rgb[((size_t)y*w+x)*3+c]=(unsigned char)floor(v+0.5);}
    }
  }return rgb;
}
/* Slice thumbnails are RGBA8 (like LOD, 16-bit inputs use their high byte).
 * Interpolate alpha and alpha-weighted color, then unpremultiply once. Hidden
 * RGB cannot create black/color fringes; opaque white is never a color key.
 * Keep this separate from JPEG white compositing and exact native RGBA8/16.
 */
static void resize_alpha_png(Source *s,FILE *out,uint32_t w,uint32_t h) {
  if(!w||!h||w>2048||h>2048||w>s->w||h>s->h)die("invalid_lod_dimensions");
  png_structp p=png_create_write_struct(PNG_LIBPNG_VER_STRING,NULL,png_error_exit,png_warning_ignore);if(!p)die("memory_budget");
  png_infop i=png_create_info_struct(p);if(!i)die("memory_budget");
  png_init_io(p,out);png_set_IHDR(p,i,w,h,8,PNG_COLOR_TYPE_RGBA,PNG_INTERLACE_NONE,PNG_COMPRESSION_TYPE_DEFAULT,PNG_FILTER_TYPE_DEFAULT);
  if(s->kind==1)copy_color_metadata(s,p,i);
  png_set_compression_level(p,6);png_set_filter(p,PNG_FILTER_TYPE_BASE,PNG_FILTER_NONE);png_write_info(p,i);
  unsigned char *dest=alloc((size_t)w*4);
  for(uint32_t y=0;y<h;y++){
    double sy=((double)y+0.5)*s->h/h-0.5;if(sy<0)sy=0;if(sy>s->h-1)sy=s->h-1;uint32_t y0=(uint32_t)sy,y1=y0+1<s->h?y0+1:y0;double fy=sy-y0;
    unsigned char *a=row(s,y0),*b=row(s,y1);
    for(uint32_t x=0;x<w;x++){
      double sx=((double)x+0.5)*s->w/w-0.5;if(sx<0)sx=0;if(sx>s->w-1)sx=s->w-1;uint32_t x0=(uint32_t)sx,x1=x0+1<s->w?x0+1:x0;double fx=sx-x0;
      const unsigned char *samples[4]={a+(size_t)x0*s->channels,a+(size_t)x1*s->channels,b+(size_t)x0*s->channels,b+(size_t)x1*s->channels};
      double weights[4]={(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy},alpha=0,premul[3]={0,0,0};
      for(int n=0;n<4;n++){double wa=weights[n]*(s->channels==4?samples[n][3]:255);alpha+=wa;for(int c=0;c<3;c++)premul[c]+=samples[n][c]*wa;}
      dest[(size_t)x*4+3]=(unsigned char)floor(alpha+0.5);
      for(int c=0;c<3;c++)dest[(size_t)x*4+c]=alpha>0?(unsigned char)floor(fmin(255,premul[c]/alpha)+0.5):0;
    }
    png_write_row(p,dest);
  }
  free(dest);png_write_end(p,NULL);png_destroy_write_struct(&p,&i);
}
static void encode_jpeg(FILE *out,unsigned char *rgb,uint32_t w,uint32_t h){struct jpeg_compress_struct c;struct jpeg_error_mgr e;c.err=jpeg_std_error(&e);e.error_exit=jpeg_error_exit;jpeg_create_compress(&c);jpeg_stdio_dest(&c,out);c.image_width=w;c.image_height=h;c.input_components=3;c.in_color_space=JCS_RGB;jpeg_set_defaults(&c);jpeg_set_quality(&c,82,TRUE);c.optimize_coding=TRUE;jpeg_start_compress(&c,TRUE);while(c.next_scanline<c.image_height){JSAMPROW p=rgb+(size_t)c.next_scanline*w*3;jpeg_write_scanlines(&c,&p,1);}jpeg_finish_compress(&c);jpeg_destroy_compress(&c);}
int main(int argc,char **argv){
  umask(077);struct rlimit memory={400ULL*1024*1024,400ULL*1024*1024},file_limit={MAX_OUTPUT,MAX_OUTPUT},cpu={60,60};if(setrlimit(RLIMIT_AS,&memory)||setrlimit(RLIMIT_FSIZE,&file_limit)||setrlimit(RLIMIT_CPU,&cpu))die("resource_limit_failed");
  if(argc==2&&!strcmp(argv[1],"--version")){printf("heron-native-codec 1.0.0 png=%s jpeg-turbo=%s webp=%d.%d.%d\n",png_get_libpng_ver(NULL),"2.1.5",(WebPGetDecoderVersion()>>16)&255,(WebPGetDecoderVersion()>>8)&255,WebPGetDecoderVersion()&255);return 0;}
  const char *input=NULL,*output=NULL,*mode=NULL;unsigned fd=0,w=0,h=0,sw=0,sh=0,x=0,y=0;int fixture_webp=0,verify=0;
  for(int a=1;a<argc;a++){if(a+1>=argc)die("missing_argument");const char *v=argv[++a];if(!strcmp(argv[a-1],"--input"))input=v;else if(!strcmp(argv[a-1],"--input-fd"))fd=number(v);else if(!strcmp(argv[a-1],"--output"))output=v;else if(!strcmp(argv[a-1],"--mode")){mode=v;fixture_webp=!strcmp(v,"fixture-webp");verify=!strcmp(v,"verify");}else if(!strcmp(argv[a-1],"--width"))w=number(v);else if(!strcmp(argv[a-1],"--height"))h=number(v);else if(!strcmp(argv[a-1],"--source-width"))sw=number(v);else if(!strcmp(argv[a-1],"--source-height"))sh=number(v);else if(!strcmp(argv[a-1],"--x"))x=number(v);else if(!strcmp(argv[a-1],"--y"))y=number(v);else die("unknown_argument");}
  if(!mode||((!output)&&!verify)||(!input&&!fd)||(input&&fd))die("invalid_arguments");int in_fd=fd?(int)fd:open(input,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(in_fd<0)die("input_open_failed");struct stat st;if(fstat(in_fd,&st)||!S_ISREG(st.st_mode)||st.st_size<=0||st.st_size>MAX_BYTES)die("source_byte_budget");if(lseek(in_fd,0,SEEK_SET)<0)die("input_seek_failed");FILE *in=fdopen(in_fd,"rb");if(!in)die("input_open_failed");
  int native=!strcmp(mode,"native"),slice_alpha=!strcmp(mode,"slice-alpha");if(!native&&!slice_alpha&&strcmp(mode,"lod")&&!fixture_webp&&!verify)die("invalid_mode");Source s;source_open(&s,in,native);if((sw&&sw!=s.w)||(sh&&sh!=s.h))die("source_dimensions_mismatch");
  if(verify){uint64_t checksum=0;for(uint32_t sy=0;sy<s.h;sy++){unsigned char *r=row(&s,sy);for(size_t n=0;n<s.stride;n++)checksum=(checksum*33)^r[n];}printf("{\"width\":%u,\"height\":%u,\"decoded\":true,\"checksum\":\"%016llx\"}\n",s.w,s.h,(unsigned long long)checksum);source_finish(&s);fclose(in);return 0;}
  int out_fd=open(output,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(out_fd<0)die("output_open_failed");FILE *out=fdopen(out_fd,"wb");if(!out)die("output_open_failed");
  if(native)crop(&s,out,x,y,w,h);else if(slice_alpha)resize_alpha_png(&s,out,w,h);else{unsigned char *rgb=resize_rgb(&s,w,h);if(fixture_webp){uint8_t *encoded=NULL;size_t len=WebPEncodeLosslessRGB(rgb,w,h,w*3,&encoded);if(!len||fwrite(encoded,1,len,out)!=len)die("webp_encode_failed");WebPFree(encoded);}else encode_jpeg(out,rgb,w,h);free(rgb);}
  source_finish(&s);if(fclose(in)||fflush(out)||fsync(out_fd)||fstat(out_fd,&st)||st.st_size<=0||st.st_size>MAX_OUTPUT||fclose(out))die("output_write_failed");return 0;
}
